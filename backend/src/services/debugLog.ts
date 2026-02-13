// In-memory debug event log with SSE streaming support.
// Events are NOT persisted — they exist only while the server is running.

export interface DebugEvent {
  id: number;
  timestamp: string;
  type:
    | 'scrape_start'
    | 'scrape_done'
    | 'scrape_fail'
    | 'matches_found'
    | 'email_sent'
    | 'email_failed'
    | 'sms_sent'
    | 'sms_failed'
    | 'job_completed'
    | 'job_failed'
    | 'search_created'
    | 'info';
  searchId?: string;
  keyword?: string;
  websiteUrl?: string;
  message: string;
  data?: unknown;
}

type Subscriber = (event: DebugEvent) => void;

const MAX_EVENTS = 500;
let nextId = 1;
const events: DebugEvent[] = [];
const subscribers = new Set<Subscriber>();

export function pushEvent(
  partial: Omit<DebugEvent, 'id' | 'timestamp'>
): DebugEvent {
  const event: DebugEvent = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    ...partial,
  };

  events.push(event);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }

  // Notify all SSE subscribers
  for (const cb of subscribers) {
    try {
      cb(event);
    } catch {
      // Subscriber disconnected — will be cleaned up
    }
  }

  return event;
}

export function getEvents(sinceId?: number): DebugEvent[] {
  if (sinceId) {
    return events.filter((e) => e.id > sinceId);
  }
  return [...events];
}

export function subscribe(cb: Subscriber): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}
