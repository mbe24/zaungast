// Deterministic synthetic dataset: a handful of university students chatting on Teams about a
// CS101 course. Entirely invented — no relation to any real person, company, or org. Every
// timestamp is derived from a single fixed base epoch (no Date.now()/no-arg new Date()), so two
// generator runs produce byte-identical output.

export const BASE_TS = Date.UTC(2026, 2, 2, 9, 0, 0); // 2026-03-02T09:00:00.000Z, fixed
const MIN = 60_000;
export const iso = (ts: number): string => new Date(ts).toISOString();

// ---- students & course bot ("profiles" store — no mapping entity extracts this today; the
// fixture still emits it so `profiles` shows up in the fingerprint/store list and so a fixture
// consumer can read it directly for people-lookup tests) ----
export interface Profile {
  mri: string;
  displayName: string;
  email: string;
  jobTitle: string;
  department: string;
}

export const STUDENTS: Profile[] = [
  {
    mri: '8:orgid:a1000000-0000-4000-8000-000000000001',
    displayName: 'Ada Lovelace',
    email: 'ada.lovelace@example.edu',
    jobTitle: 'Student',
    department: 'Computer Science',
  },
  {
    mri: '8:orgid:a1000000-0000-4000-8000-000000000002',
    displayName: 'Alan Turing',
    email: 'alan.turing@example.edu',
    jobTitle: 'Student',
    department: 'Computer Science',
  },
  {
    mri: '8:orgid:a1000000-0000-4000-8000-000000000003',
    displayName: 'Grace Hopper',
    email: 'grace.hopper@example.edu',
    jobTitle: 'Student',
    department: 'Computer Science',
  },
  {
    mri: '8:orgid:a1000000-0000-4000-8000-000000000004',
    displayName: 'Barbara Liskov',
    email: 'barbara.liskov@example.edu',
    jobTitle: 'Student',
    department: 'Computer Science',
  },
  {
    mri: '8:orgid:a1000000-0000-4000-8000-000000000005',
    displayName: 'Edsger Dijkstra',
    email: 'edsger.dijkstra@example.edu',
    jobTitle: 'Student',
    department: 'Computer Science',
  },
  {
    mri: '8:orgid:a1000000-0000-4000-8000-000000000006',
    displayName: 'Radia Perlman',
    email: 'radia.perlman@example.edu',
    jobTitle: 'Student',
    department: 'Computer Science',
  },
];
export const COURSE_BOT: Profile = {
  mri: '28:b0000000-0000-4000-8000-000000000001',
  displayName: 'CS101 Course Bot',
  email: '',
  jobTitle: 'Bot',
  department: 'Computer Science',
};
// Margaret Hamilton has a profile in ALL_PROFILES but never authors a message anywhere in this
// fixture — this proves reactor display names can resolve via the profiles store alone, not just
// via message senders. She only ever appears as a reactor (see the study-group welcome message).
export const SILENT_PROFILE: Profile = {
  mri: '8:orgid:a1000000-0000-4000-8000-000000000007',
  displayName: 'Margaret Hamilton',
  email: 'margaret.hamilton@example.edu',
  jobTitle: 'Student',
  department: 'Computer Science',
};
export const ALL_PROFILES: Profile[] = [...STUDENTS, COURSE_BOT, SILENT_PROFILE];

const [ada, alan, grace, barbara, edsger, radia] = STUDENTS;
export const SELF = ada; // the fixture models Ada Lovelace's own Teams cache

// ---- conversations ----
export interface ConversationDef {
  id: string;
  type: string;
  teamId: string | null;
  topic?: string;
  threadType?: string;
  messages: MessageDef[];
}
export interface MessageDef {
  sender: Profile;
  content: string;
  ts: number;
  messageType?: string; // default 'RichText/Html'
  contentType?: string; // default 'text'
  isSentByCurrentUser?: boolean;
  mentions?: { mri: string; displayName: string }[];
  files?: string[];
  systemType?: string; // when set, messageType becomes `ThreadActivity/${systemType}` and content is a control blob
  // Real shape: message.properties.emotions = [ { key, users: [ { mri, time } ] } ]. `key` is a
  // Teams reaction shortcode (e.g. 'like', 'heart', '1f389_partypopper'); `users` is per-reactor.
  reactions?: { key: string; users: { mri: string; time: number }[] }[];
}

let t = BASE_TS;
const next = (): number => {
  const v = t;
  t += 5 * MIN;
  return v;
}; // 5-minute cadence, strictly increasing

// Separate counter for reaction timestamps, deliberately offset well past every message ts this
// fixture can produce (a handful of messages at a 5-minute cadence never reach 200 * MIN past
// BASE_TS), so every reaction decodes as happening after its message was sent. Each call yields a
// distinct, strictly increasing time — used only to make reactor recency-ordering testable; the
// exact values carry no other meaning.
let rt = BASE_TS + 200 * MIN;
const nextReactionTime = (): number => {
  const v = rt;
  rt += MIN;
  return v;
};

export const CONVERSATIONS: ConversationDef[] = [
  {
    id: '19:a1b2c3d4e5f6@unq.gbl.spaces', // 1:1 DM (convKind: '@unq.gbl.spaces' -> '1:1')
    type: 'Chat',
    teamId: null,
    messages: [
      {
        sender: ada,
        content: 'Hey Alan, did you finish problem set 3?',
        ts: next(),
        isSentByCurrentUser: true,
      },
      {
        sender: alan,
        content:
          'Almost! Stuck on the Dijkstra part. Here is my scratch work: <img src="https://example.invalid/img/pset3-scratch.png">',
        ts: next(),
      },
      {
        sender: ada,
        content: "Haha fitting given the professor's name. Let's meet before class.",
        ts: next(),
        isSentByCurrentUser: true,
        // Single emoji, single reactor.
        reactions: [{ key: 'like', users: [{ mri: alan.mri, time: nextReactionTime() }] }],
      },
    ],
  },
  {
    id: '19:f1e2d3c4b5a6@thread.v2', // group chat (convKind: '@thread.v2' -> 'group')
    type: 'Chat',
    teamId: null,
    topic: 'study-group-cs101',
    threadType: 'chat',
    messages: [
      {
        sender: grace,
        content:
          '<addedMembers>Ada Lovelace, Alan Turing, Barbara Liskov, Edsger Dijkstra, Radia Perlman</addedMembers>',
        ts: next(),
        systemType: 'AddMember',
      },
      {
        sender: barbara,
        content: '<p>Welcome to the <b>CS101</b> study group!</p>',
        ts: next(),
        files: ['https://example.invalid/files/syllabus.pdf'],
        // Multiple distinct emojis (3), per-emoji grouping. The 'surprised' group's only reactor
        // is SILENT_PROFILE (Margaret Hamilton), who never authors a message in this fixture —
        // see SILENT_PROFILE's declaration above for why that matters.
        reactions: [
          { key: 'heart', users: [{ mri: radia.mri, time: nextReactionTime() }] },
          {
            key: '1f389_partypopper',
            users: [
              { mri: edsger.mri, time: nextReactionTime() },
              { mri: barbara.mri, time: nextReactionTime() }, // author reacting to own message
            ],
          },
          { key: 'surprised', users: [{ mri: SILENT_PROFILE.mri, time: nextReactionTime() }] },
        ],
      },
      {
        sender: edsger,
        content: 'Can someone explain memoization vs dynamic programming?',
        ts: next(),
      },
      {
        sender: COURSE_BOT,
        content: 'Reminder: Assignment 4 is due Friday at 11:59pm.',
        ts: next(),
        // Single emoji, several (5) reactors — exercises a name-cap-of-3 + "+2" overflow. One
        // reactor (ada) is SELF/the current user reacting to someone else's message.
        reactions: [
          {
            key: 'laugh',
            users: [
              { mri: alan.mri, time: nextReactionTime() },
              { mri: grace.mri, time: nextReactionTime() },
              { mri: barbara.mri, time: nextReactionTime() },
              { mri: edsger.mri, time: nextReactionTime() },
              { mri: ada.mri, time: nextReactionTime() }, // ada === SELF (current user)
            ],
          },
        ],
      },
      {
        sender: radia,
        content: 'Thanks bot! @Ada Lovelace can you share your notes?',
        ts: next(),
        mentions: [{ mri: ada.mri, displayName: ada.displayName }],
      },
      { sender: ada, content: 'Sure, sharing now.', ts: next(), isSentByCurrentUser: true },
    ],
  },
  {
    id: '19:11223344aabb@thread.tacv2', // course channel (convKind: '@thread.tacv2' -> 'channel')
    type: 'Channel',
    teamId: 'team-cs101-guid-0000',
    topic: 'CS101 Algorithms - General',
    threadType: 'channel',
    messages: [
      { sender: edsger, content: 'Welcome to CS101: Algorithms and Data Structures.', ts: next() },
      {
        sender: grace,
        content: 'Lecture slides for week 5 are posted.',
        ts: next(),
        files: ['https://example.invalid/files/week5-slides.pdf'],
      },
      {
        sender: ada,
        content: "Thanks! Quick question about Big-O from today's lecture.",
        ts: next(),
        isSentByCurrentUser: true,
      },
      {
        sender: grace,
        content: '<topicUpdate>CS101 Algorithms - General</topicUpdate>',
        ts: next(),
        systemType: 'TopicUpdate',
      },
    ],
  },
  {
    id: '19:meeting_998877@thread.v2', // meeting (convKind: 'meeting_' substring -> 'meeting', checked before '@thread.v2')
    type: 'Meeting',
    teamId: null,
    topic: 'CS101 Midterm Review Session',
    threadType: 'meeting',
    messages: [
      { sender: alan, content: 'Looking forward to the midterm review!', ts: next() },
      { sender: ada, content: 'See everyone at 3pm.', ts: next(), isSentByCurrentUser: true },
    ],
  },
];
