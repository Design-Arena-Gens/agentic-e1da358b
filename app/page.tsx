/* eslint-disable react/no-array-index-key */
"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  addDays,
  format,
  isAfter,
  isValid as isValidDate,
  isWeekend,
  parse,
  startOfToday
} from "date-fns";

type Sender = "assistant" | "user";

interface Message {
  id: string;
  sender: Sender;
  text: string;
  timestamp: number;
}

interface Slot {
  date: string;
  time: string;
}

interface AppointmentDetails {
  name?: string;
  email?: string;
  purpose?: string;
  durationMinutes?: number;
  preferredDate?: string;
  preferredTime?: string;
  timezone?: string;
}

interface ConfirmedAppointment extends AppointmentDetails {
  slot: Slot;
  summary: string;
  confirmationTime: number;
}

type ConversationStep =
  | "need-name"
  | "need-email"
  | "need-purpose"
  | "need-duration"
  | "need-date"
  | "need-time"
  | "need-timezone"
  | "confirming"
  | "confirmed";

interface ChatState {
  messages: Message[];
  step: ConversationStep;
  appointment: AppointmentDetails;
  pendingSlot?: Slot;
  suggestedSlots: Slot[];
  bookedAppointments: ConfirmedAppointment[];
  availability: Record<string, string[]>;
}

type Action =
  | { type: "append-message"; payload: Message }
  | {
      type: "append-messages";
      payload: Message[];
    }
  | { type: "set-state"; payload: Partial<ChatState> };

const DEFAULT_TIMES = ["09:00", "11:30", "14:00", "16:00"];

const initialState: ChatState = {
  messages: [],
  step: "need-name",
  appointment: {},
  pendingSlot: undefined,
  suggestedSlots: [],
  bookedAppointments: [],
  availability: {}
};

function createMessage(sender: Sender, text: string): Message {
  return {
    id: crypto.randomUUID(),
    sender,
    text,
    timestamp: Date.now()
  };
}

function createAvailability(): Record<string, string[]> {
  const availability: Record<string, string[]> = {};
  const today = startOfToday();
  let cursor = today;
  let generated = 0;

  while (generated < 21) {
    if (!isWeekend(cursor)) {
      const dateKey = format(cursor, "yyyy-MM-dd");
      availability[dateKey] = [...DEFAULT_TIMES];
      generated += 1;
    }
    cursor = addDays(cursor, 1);
  }

  return availability;
}

const formatName = (input: string) =>
  input
    .trim()
    .split(/\s+/)
    .map((chunk) => chunk[0]?.toUpperCase() + chunk.slice(1).toLowerCase())
    .join(" ");

const extractFirstName = (input: string) => input.split(" ")[0] ?? input;

function parseEmail(input: string): string | null {
  const match = input
    .trim()
    .match(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?=$|\s|\.|,|;|!|\?)/u
    );
  return match ? match[0].toLowerCase() : null;
}

function parseDurationMinutes(input: string): number | null {
  const numericMatch = input.match(/(\d+(?:\.\d+)?)/u);
  if (!numericMatch) {
    return null;
  }
  const value = Number(numericMatch[1]);
  if (Number.isNaN(value) || value <= 0) {
    return null;
  }

  const mentionsHours = /hour|hr|h\b/i.test(input);
  const mentionsMinutes = /minute|min|m\b/i.test(input);

  if (mentionsHours && !mentionsMinutes) {
    return Math.round(value * 60);
  }

  if (!mentionsHours && !mentionsMinutes && value <= 6) {
    return Math.round(value * 60);
  }

  return Math.round(value);
}

const dateFormats = [
  "yyyy-MM-dd",
  "MM/dd/yyyy",
  "MMMM d, yyyy",
  "MMMM d yyyy",
  "MMM d, yyyy",
  "MMM d yyyy",
  "MMMM d",
  "MMM d",
  "EEEE, MMMM d",
  "EEEE MMMM d"
];

function parsePreferredDate(input: string): string | null {
  const trimmed = input.trim();
  const today = startOfToday();

  for (const formatPattern of dateFormats) {
    const parsed = parse(trimmed, formatPattern, today);
    if (isValidDate(parsed)) {
      const normalized = format(parsed, "yyyy-MM-dd");
      if (isAfter(parsed, addDays(today, -1))) {
        return normalized;
      }
    }
  }

  const fallback = new Date(trimmed);
  if (isValidDate(fallback) && isAfter(fallback, addDays(today, -1))) {
    return format(fallback, "yyyy-MM-dd");
  }

  return null;
}

function parsePreferredTime(input: string): string | null {
  const match = input.match(
    /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/iu
  );
  if (!match) {
    return null;
  }
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? "0");
  const meridiem = match[3]?.toLowerCase() ?? "";

  if (hours > 24 || minutes >= 60) {
    return null;
  }

  if (meridiem.includes("p") && hours < 12) {
    hours += 12;
  } else if (meridiem.includes("a") && hours === 12) {
    hours = 0;
  }

  if (!meridiem && hours < 8) {
    hours += 12;
  }

  if (hours >= 24) {
    return null;
  }

  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}`;
}

function formatSlotHumanReadable(
  slot: Slot,
  timezone?: string | null
): string {
  const parsed = parse(
    `${slot.date} ${slot.time}`,
    "yyyy-MM-dd HH:mm",
    startOfToday()
  );
  if (!isValidDate(parsed)) {
    return `${slot.date} at ${slot.time}${timezone ? ` (${timezone})` : ""}`;
  }
  const dateLabel = format(parsed, "EEEE, MMMM d");
  const timeLabel = format(parsed, "h:mm a");
  return `${dateLabel} at ${timeLabel}${timezone ? ` (${timezone})` : ""}`;
}

function isSlotBooked(slot: Slot, booked: ConfirmedAppointment[]): boolean {
  return booked.some(
    (appointment) =>
      appointment.slot.date === slot.date &&
      appointment.slot.time === slot.time
  );
}

function buildAlternatives(
  availability: Record<string, string[]>,
  requestedDate: string | undefined,
  booked: ConfirmedAppointment[],
  limit = 3
): Slot[] {
  const options: Slot[] = [];
  const dates = Object.keys(availability).sort();

  if (requestedDate) {
    const sameDayOptions =
      availability[requestedDate]?.filter(
        (time) => !isSlotBooked({ date: requestedDate, time }, booked)
      ) ?? [];
    sameDayOptions.forEach((time) => {
      if (options.length < limit) {
        options.push({ date: requestedDate, time });
      }
    });
  }

  for (const date of dates) {
    if (options.length >= limit) {
      break;
    }
    if (requestedDate && date < requestedDate) {
      continue;
    }
    for (const time of availability[date]) {
      const candidate = { date, time };
      if (!isSlotBooked(candidate, booked)) {
        if (
          !options.some(
            (option) => option.date === candidate.date && option.time === candidate.time
          )
        ) {
          options.push(candidate);
        }
      }
      if (options.length >= limit) {
        break;
      }
    }
  }

  return options.slice(0, limit);
}

const reducer = (state: ChatState, action: Action): ChatState => {
  switch (action.type) {
    case "append-message":
      return {
        ...state,
        messages: [...state.messages, action.payload]
      };
    case "append-messages":
      return {
        ...state,
        messages: [...state.messages, ...action.payload]
      };
    case "set-state":
      return {
        ...state,
        ...action.payload
      };
    default:
      return state;
  }
};

function useChatState() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!initialized) {
      dispatch({
        type: "set-state",
        payload: {
          availability: createAvailability()
        }
      });
      dispatch({
        type: "append-message",
        payload: createMessage(
          "assistant",
          "Hello there! I'm your scheduling assistant. Let's find the perfect time for your meeting. May I have your full name to get started?"
        )
      });
      setInitialized(true);
    }
  }, [initialized]);

  return { state, dispatch };
}

function evaluateAssistantResponse(
  currentState: ChatState,
  latestUserInput: string
): { stateUpdate: Partial<ChatState>; replies: string[] } {
  const trimmed = latestUserInput.trim();
  const replies: string[] = [];
  const updates: Partial<ChatState> = {};
  const appointment = { ...currentState.appointment };
  let { step, suggestedSlots, pendingSlot } = currentState;

  const availability = currentState.availability;
  const bookedAppointments = currentState.bookedAppointments;

  const ensureAskForDate = () => {
    replies.push(
      "Thank you. Do you have a preferred date for this appointment? Please mention a specific day."
    );
    step = "need-date";
  };

  const ensureAskForTime = () => {
    replies.push(
      "Great. What time works best for you on that day?"
    );
    step = "need-time";
  };

  const ensureAskForTimezone = () => {
    replies.push(
      "Lastly, which time zone should I use so we stay aligned?"
    );
    step = "need-timezone";
  };

  switch (step) {
    case "need-name": {
      if (trimmed.length < 2) {
        replies.push(
          "I want to make sure I have your name correct. Could you please share your full name?"
        );
        break;
      }
      const name = formatName(trimmed);
      appointment.name = name;
      const firstName = extractFirstName(name);
      replies.push(
        `Wonderful, ${firstName}. What's the best email address for your confirmation?`
      );
      step = "need-email";
      break;
    }
    case "need-email": {
      const email = parseEmail(trimmed);
      if (!email) {
        replies.push(
          "It looks like I couldn't capture that email. Would you mind sharing it in a format like name@example.com?"
        );
        break;
      }
      appointment.email = email;
      replies.push(
        "Thanks! What’s the purpose of this meeting so I can note it accurately?"
      );
      step = "need-purpose";
      break;
    }
    case "need-purpose": {
      if (!trimmed) {
        replies.push(
          "A short note about the purpose helps me prepare. Could you share a brief description?"
        );
        break;
      }
      appointment.purpose = trimmed;
      replies.push(
        "Perfect. How long should we plan for? You can mention something like 30 minutes or 1 hour."
      );
      step = "need-duration";
      break;
    }
    case "need-duration": {
      const duration = parseDurationMinutes(trimmed);
      if (!duration) {
        replies.push(
          "Just to be sure, how many minutes should I block off? Feel free to say something like 45 minutes or 1 hour."
        );
        break;
      }
      appointment.durationMinutes = duration;
      ensureAskForDate();
      break;
    }
    case "need-date": {
      const date = parsePreferredDate(trimmed);
      if (!date) {
        replies.push(
          "I wasn't able to recognize that date. Could you share it again, perhaps including the month and day?"
        );
        break;
      }
      appointment.preferredDate = date;
      ensureAskForTime();
      break;
    }
    case "need-time": {
      const time = parsePreferredTime(trimmed);
      if (!time) {
        replies.push(
          "Got it. For clarity, what start time would you prefer? You can share it like 10:30 AM or 14:00."
        );
        break;
      }
      appointment.preferredTime = time;
      ensureAskForTimezone();
      break;
    }
    case "need-timezone": {
      if (!trimmed) {
        replies.push(
          "To avoid any mix ups, which time zone should I reference?"
        );
        break;
      }
      appointment.timezone = trimmed.trim();

      if (!appointment.preferredDate || !appointment.preferredTime) {
        ensureAskForDate();
        suggestedSlots = [];
        break;
      }

      const requestedSlot: Slot = {
        date: appointment.preferredDate,
        time: appointment.preferredTime
      };

      const availableTimesForDate =
        availability[requestedSlot.date]?.filter(
          (time) => !isSlotBooked({ date: requestedSlot.date, time }, bookedAppointments)
        ) ?? [];

      const slotAvailable = availableTimesForDate.includes(
        requestedSlot.time
      );

      if (slotAvailable) {
        pendingSlot = requestedSlot;
        const summary = formatSlotHumanReadable(
          requestedSlot,
          appointment.timezone
        );
        replies.push(
          `Here is what I have:\n• Name: ${appointment.name}\n• Email: ${appointment.email}\n• Purpose: ${appointment.purpose}\n• Duration: ${appointment.durationMinutes} minutes\n• Preferred time: ${summary}\n\nDoes this look right? Please confirm so I can reserve it.`
        );
        suggestedSlots = [];
        step = "confirming";
      } else {
        const alternatives = buildAlternatives(
          availability,
          appointment.preferredDate,
          bookedAppointments
        );
        if (alternatives.length === 0) {
          replies.push(
            "It seems everything is booked around that time. Could you share another date or time that works for you?"
          );
          appointment.preferredTime = undefined;
          appointment.preferredDate = undefined;
          step = "need-date";
          suggestedSlots = [];
        } else {
          const rendered = alternatives
            .map(
              (slot, index) =>
                `${index + 1}. ${formatSlotHumanReadable(
                  slot,
                  appointment.timezone
                )}`
            )
            .join("\n");
          replies.push(
            `The ${formatSlotHumanReadable(
              requestedSlot,
              appointment.timezone
            )} slot isn't open. Here are the closest options:\n${rendered}\n\nLet me know which option works for you or share another preference.`
          );
          suggestedSlots = alternatives;
          step = "need-time";
          appointment.preferredTime = undefined;
        }
      }
      break;
    }
    case "confirming": {
      const normalized = trimmed.toLowerCase();
      if (/(^|\b)(yes|y|confirm|sounds good|works|locked in)(\b|$)/i.test(normalized)) {
        if (pendingSlot) {
          const confirmed: ConfirmedAppointment = {
            ...appointment,
            slot: pendingSlot,
            summary: formatSlotHumanReadable(pendingSlot, appointment.timezone),
            confirmationTime: Date.now()
          };
          const updatedBooked = [...bookedAppointments, confirmed];
          replies.push(
            `All set! I've booked ${confirmed.summary} for ${appointment.name}. A confirmation will arrive at ${appointment.email} shortly.`
          );
          replies.push(
            "If you need any adjustments or want to schedule something else, just let me know."
          );
          updates.bookedAppointments = updatedBooked;
          updates.appointment = {};
          updates.pendingSlot = undefined;
          updates.step = "confirmed";
          updates.suggestedSlots = [];
        } else {
          replies.push(
            "Thanks for confirming. I encountered a hiccup locating that slot. Could you share the preferred date and time once more?"
          );
          step = "need-date";
        }
      } else if (
        /(no|change|different|adjust|update|another)/i.test(normalized)
      ) {
        replies.push(
          "No problem. Let's pick another time. Do you have a different date in mind?"
        );
        appointment.preferredDate = undefined;
        appointment.preferredTime = undefined;
        pendingSlot = undefined;
        step = "need-date";
      } else {
        replies.push(
          "Just let me know with a quick “yes” to confirm or “no” if we should look at another slot."
        );
      }
      break;
    }
    case "confirmed": {
      replies.push(
        "Happy to help further. Are you looking to book another appointment? If so, let's start with the attendee's name."
      );
      appointment.name = undefined;
      appointment.email = undefined;
      appointment.purpose = undefined;
      appointment.durationMinutes = undefined;
      appointment.preferredDate = undefined;
      appointment.preferredTime = undefined;
      appointment.timezone = undefined;
      step = "need-name";
      break;
    }
    default:
      replies.push(
        "Let's make sure we're aligned. Could you please share the attendee's full name?"
      );
      step = "need-name";
      break;
  }

  updates.step = step;
  updates.appointment = appointment;
  updates.suggestedSlots = suggestedSlots;
  updates.pendingSlot = pendingSlot;

  return { stateUpdate: updates, replies };
}

function Conversation() {
  const { state, dispatch } = useChatState();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages]);

  const pendingAppointments = useMemo(
    () =>
      state.bookedAppointments
        .slice()
        .sort((a, b) => a.confirmationTime - b.confirmationTime),
    [state.bookedAppointments]
  );

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }
    const userMessage = createMessage("user", trimmed);
    dispatch({ type: "append-message", payload: userMessage });

    const { stateUpdate, replies } = evaluateAssistantResponse(state, trimmed);

    if (Object.keys(stateUpdate).length > 0) {
      dispatch({ type: "set-state", payload: stateUpdate });
    }

    if (replies.length > 0) {
      const assistantMessages = replies.map((reply) =>
        createMessage("assistant", reply)
      );
      dispatch({ type: "append-messages", payload: assistantMessages });
    }

    setInput("");
  };

  return (
    <main
      style={{
        display: "flex",
        justifyContent: "center",
        padding: "48px 16px"
      }}
    >
      <div
        style={{
          maxWidth: "960px",
          width: "100%",
          background: "#ffffff",
          borderRadius: "24px",
          boxShadow: "0 24px 60px rgba(15, 35, 75, 0.08)",
          display: "flex",
          overflow: "hidden"
        }}
      >
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: "640px"
          }}
        >
          <header
            style={{
              padding: "32px 32px 16px",
              borderBottom: "1px solid rgba(23, 43, 77, 0.08)"
            }}
          >
            <h1
              style={{
                margin: 0,
                fontSize: "1.75rem",
                fontWeight: 600
              }}
            >
              Appointment Concierge
            </h1>
            <p
              style={{
                margin: "8px 0 0",
                color: "#5f6c80",
                fontSize: "0.95rem",
                lineHeight: 1.4
              }}
            >
              A dedicated assistant to arrange meetings smoothly and professionally.
            </p>
          </header>

          <div
            style={{
              flex: 1,
              padding: "24px 32px",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: "16px"
            }}
          >
            {state.messages.map((message) => (
              <div
                key={message.id}
                style={{
                  display: "flex",
                  justifyContent:
                    message.sender === "assistant" ? "flex-start" : "flex-end"
                }}
              >
                <div
                  style={{
                    maxWidth: "75%",
                    whiteSpace: "pre-wrap",
                    background:
                      message.sender === "assistant"
                        ? "#f0f4ff"
                        : "#274bff",
                    color:
                      message.sender === "assistant" ? "#12214a" : "#ffffff",
                    padding: "16px 18px",
                    borderRadius:
                      message.sender === "assistant"
                        ? "18px 18px 18px 6px"
                        : "18px 18px 6px 18px",
                    fontSize: "0.98rem",
                    lineHeight: 1.5,
                    border:
                      message.sender === "assistant"
                        ? "1px solid rgba(39, 75, 255, 0.24)"
                        : "1px solid rgba(39, 75, 255, 0.2)",
                    boxShadow:
                      message.sender === "assistant"
                        ? "0 6px 16px rgba(27, 68, 170, 0.09)"
                        : "0 6px 18px rgba(39, 75, 255, 0.25)"
                  }}
                >
                  {message.text}
                </div>
              </div>
            ))}
            <div ref={scrollRef} />
          </div>

          <form
            onSubmit={handleSubmit}
            style={{
              padding: "16px 32px 28px",
              borderTop: "1px solid rgba(23, 43, 77, 0.08)",
              background: "#ffffff",
              display: "flex",
              flexDirection: "column",
              gap: "12px"
            }}
          >
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Type your reply..."
              rows={3}
              style={{
                resize: "none",
                width: "100%",
                padding: "16px 18px",
                borderRadius: "16px",
                border: "1px solid rgba(39, 75, 255, 0.18)",
                fontSize: "1rem",
                lineHeight: 1.5,
                outline: "none",
                background: "#f7f9ff"
              }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px"
              }}
            >
              <small style={{ color: "#68748c" }}>
                The assistant guides you with one-step clarity to finalize a meeting.
              </small>
              <button
                type="submit"
                style={{
                  border: "none",
                  background: "#274bff",
                  color: "#ffffff",
                  padding: "12px 24px",
                  borderRadius: "999px",
                  fontWeight: 600,
                  cursor: "pointer",
                  fontSize: "1rem",
                  boxShadow: "0 10px 24px rgba(39, 75, 255, 0.25)"
                }}
              >
                Send
              </button>
            </div>
          </form>
        </div>
        <aside
          style={{
            width: "320px",
            borderLeft: "1px solid rgba(23, 43, 77, 0.08)",
            background: "#f8faff",
            padding: "32px 24px",
            display: "flex",
            flexDirection: "column",
            gap: "24px"
          }}
        >
          <div>
            <h2
              style={{
                margin: "0 0 16px",
                fontSize: "1.1rem",
                fontWeight: 600,
                color: "#152550"
              }}
            >
              Confirmed Appointments
            </h2>
            {pendingAppointments.length === 0 ? (
              <p
                style={{
                  fontSize: "0.95rem",
                  color: "#6f7b94",
                  margin: 0
                }}
              >
                Once a meeting is scheduled, you will see a quick recap here.
              </p>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "16px"
                }}
              >
                {pendingAppointments.map((appointment) => (
                  <div
                    key={`${appointment.slot.date}-${appointment.slot.time}-${appointment.email}`}
                    style={{
                      background: "#ffffff",
                      borderRadius: "16px",
                      padding: "16px",
                      border: "1px solid rgba(39, 75, 255, 0.18)",
                      boxShadow: "0 12px 24px rgba(27, 68, 170, 0.08)"
                    }}
                  >
                    <p
                      style={{
                        margin: "0 0 8px",
                        fontWeight: 600,
                        color: "#1d2c5b"
                      }}
                    >
                      {appointment.name}
                    </p>
                    <p
                      style={{
                        margin: "0 0 6px",
                        fontSize: "0.95rem",
                        color: "#46597a"
                      }}
                    >
                      {appointment.purpose}
                    </p>
                    <p
                      style={{
                        margin: "0 0 6px",
                        fontSize: "0.95rem",
                        color: "#1d2c5b"
                      }}
                    >
                      {appointment.summary}
                    </p>
                    <p
                      style={{
                        margin: 0,
                        fontSize: "0.9rem",
                        color: "#6f7b94"
                      }}
                    >
                      {appointment.durationMinutes} minutes · {appointment.email}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div
            style={{
              padding: "20px",
              borderRadius: "18px",
              border: "1px solid rgba(39, 75, 255, 0.16)",
              background: "#ffffff",
              boxShadow: "0 16px 32px rgba(27, 68, 170, 0.12)"
            }}
          >
            <h3
              style={{
                margin: "0 0 12px",
                fontSize: "1rem",
                fontWeight: 600,
                color: "#203463"
              }}
            >
              Availability Snapshot
            </h3>
            <p
              style={{
                margin: "0 0 12px",
                fontSize: "0.92rem",
                color: "#556586",
                lineHeight: 1.4
              }}
            >
              Weekdays between 9:00 AM and 4:00 PM are typically open. The
              assistant checks conflicts automatically when you share your
              preference.
            </p>
            <p
              style={{
                margin: 0,
                fontSize: "0.9rem",
                color: "#6f7b94"
              }}
            >
              Need something outside of these hours? Just mention it and the
              assistant will look for the closest fit.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}

export default function HomePage() {
  return <Conversation />;
}
