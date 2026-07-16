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
  replyTo?: number; // the ts of the reply-chain ROOT this message answers (absent ⇒ this is a root)
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
    messages: ((): MessageDef[] => {
      // Two reply-chains (A small, C large) interleaved in time, plus a bare root B — so channel
      // threading is exercised: grouping (not time-order), the ≤5 show-all gate, a self/(you)
      // reply, and a thread big enough to truncate in the digest yet inline whole in thread mode.
      const a = next(); // thread A root
      const b = next(); // bare root B (no replies)
      const a1 = next(); // A reply
      const c = next(); // thread C root
      const a2 = next(); // A reply (from the owner)
      const c1 = next(),
        c2 = next(),
        c3 = next(),
        c4 = next(),
        c5 = next(),
        c6 = next(); // C replies (root + 6 = 7 total ⇒ digest truncates to root + last 3)
      return [
        { sender: edsger, content: 'Welcome to CS101: Algorithms and Data Structures.', ts: a },
        {
          sender: grace,
          content: 'Lecture slides for week 5 are posted.',
          ts: b,
          files: ['https://example.invalid/files/week5-slides.pdf'],
        },
        { sender: alan, content: 'Are the lectures recorded too?', ts: a1, replyTo: a },
        { sender: barbara, content: 'Reading list for the sorting unit - suggestions?', ts: c },
        {
          sender: ada,
          content: "I'll post the recording link after class.",
          ts: a2,
          replyTo: a,
          isSentByCurrentUser: true,
        },
        { sender: grace, content: 'CLRS chapter 8 is the classic.', ts: c1, replyTo: c },
        { sender: alan, content: 'Sedgewick has nice animations.', ts: c2, replyTo: c },
        { sender: edsger, content: 'Skiena for building intuition.', ts: c3, replyTo: c },
        { sender: radia, content: 'The Knuth volume if you dare.', ts: c4, replyTo: c },
        { sender: barbara, content: 'Thanks all - great suggestions.', ts: c5, replyTo: c },
        { sender: grace, content: "I'll pin these to the channel.", ts: c6, replyTo: c },
        {
          sender: grace,
          content: '<topicUpdate>CS101 Algorithms - General</topicUpdate>',
          ts: next(),
          systemType: 'TopicUpdate',
        },
      ];
    })(),
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

// ---- calendar ("event" mapping entity — src/schema/versions/teams-2026-07.json) ----
// Fixed ISO timestamps (no Date.now()/no-arg new Date()), clustered near BASE_TS's month so a
// single since:'2026-01-01' window in tests covers everything deterministically.
const evIso = (day: number, hour: number, minute = 0): string =>
  new Date(Date.UTC(2026, 2, day, hour, minute, 0)).toISOString();

export interface AttendeeDef {
  name: string;
  address: string;
  // In real Teams every attendee's `role` is uniformly "User"; the meaningful distinction lives in
  // `type` (Organizer | Required | Optional | Resource — rooms are 'Resource'). So we don't declare
  // role per-attendee — the generator emits the constant "User" — and express intent via `type`.
  type?: string; // default 'Required'
  response?: string; // status.response
}
export interface EventDef {
  objectId: string;
  seriesMasterId?: string | null;
  subject: string;
  startTime: string;
  endTime: string;
  isAllDayEvent?: boolean;
  location?: string;
  organizerName?: string;
  organizerAddress?: string;
  isOnlineMeeting?: boolean;
  cid?: string | null; // -> skypeTeamsDataObject.cid
  isAppointment?: boolean;
  myResponseType?: string;
  showAs?: string;
  isCancelled?: boolean;
  eventType?: string | null; // 'RecurringMaster' | 'Occurrence' | 'Exception' | undefined (single)
  sensitivityLabelId?: string | null;
  doNotForward?: boolean;
  hasAttachments?: boolean;
  attendees?: AttendeeDef[];
  bodyContent?: string;
}

// Shared series id for the recurring-standup group below (run-collapse test).
const STANDUP_SERIES = 'series-standup-001';

export const EVENTS: EventDef[] = [
  // Plain appointment: no cid, no attendees — the calendar-only bucket (feature.calendar-meeting.md).
  {
    objectId: 'evt-appt-dentist',
    subject: 'Dentist appointment',
    startTime: evIso(10, 14, 0),
    endTime: evIso(10, 14, 30),
    organizerName: ada.displayName,
    organizerAddress: ada.email,
    myResponseType: 'Organizer',
    showAs: 'Busy',
  },
  // Online meeting whose cid MATCHES an existing fixture conversation (chat-pivot resolves).
  {
    objectId: 'evt-meeting-cached',
    subject: 'CS101 Midterm Review Session',
    startTime: evIso(11, 15, 0),
    endTime: evIso(11, 15, 30),
    organizerName: alan.displayName,
    organizerAddress: alan.email,
    isOnlineMeeting: true,
    cid: '19:meeting_998877@thread.v2', // == CONVERSATIONS[3].id above
    myResponseType: 'Accepted',
    showAs: 'Busy',
    attendees: [
      { name: ada.displayName, address: ada.email, type: 'Organizer', response: 'Accepted' },
      { name: alan.displayName, address: alan.email, type: 'Required', response: 'Accepted' },
      { name: grace.displayName, address: grace.email, type: 'Required', response: 'Tentative' },
      // A meeting room (type:'Resource') — must be filtered out of the attendee list + count.
      {
        name: 'Room CS-101',
        address: 'room-cs101@example.edu',
        type: 'Resource',
        response: 'Accepted',
      },
    ],
  },
  // Online meeting whose cid has NO matching conversation — must render "(no cached chat)".
  {
    objectId: 'evt-meeting-nocache',
    subject: 'Guest Lecture: Distributed Systems',
    startTime: evIso(12, 10, 0),
    endTime: evIso(12, 11, 0),
    organizerName: edsger.displayName,
    organizerAddress: edsger.email,
    isOnlineMeeting: true,
    cid: '19:meeting_nomatch111@thread.v2', // deliberately absent from CONVERSATIONS
    myResponseType: 'NotResponded',
    showAs: 'Busy',
    attendees: [
      { name: ada.displayName, address: ada.email, type: 'Required', response: 'None' },
      { name: edsger.displayName, address: edsger.email, type: 'Organizer', response: 'Accepted' },
    ],
  },
  // [cancelled] event — shown by default, tagged; hide_cancelled:true must filter it out.
  {
    objectId: 'evt-cancelled-study',
    subject: 'Cancelled Study Session',
    startTime: evIso(13, 9, 0),
    endTime: evIso(13, 9, 30),
    organizerName: barbara.displayName,
    organizerAddress: barbara.email,
    isCancelled: true,
    showAs: 'Free',
  },
  // Plain appointment WITH a body — positive include_body case (narrowed single-result rendering
  // + URL-to-hostname elision), contrasted against the confidential event's suppression below.
  {
    objectId: 'evt-appt-with-body',
    subject: 'Room Booking Confirmation',
    startTime: evIso(15, 11, 0),
    endTime: evIso(15, 11, 15),
    organizerName: ada.displayName,
    organizerAddress: ada.email,
    myResponseType: 'Organizer',
    showAs: 'Busy',
    bodyContent: '<p>Room booked. Floor plan: https://example.invalid/floorplans/room3</p>',
  },
  // [confidential] event — body MUST stay suppressed even with include_body:true. Contains a URL
  // (elision would apply if it were ever rendered — it must not be).
  {
    objectId: 'evt-confidential-1on1',
    subject: 'Confidential 1:1',
    startTime: evIso(14, 13, 0),
    endTime: evIso(14, 13, 30),
    organizerName: ada.displayName,
    organizerAddress: ada.email,
    doNotForward: true,
    myResponseType: 'Organizer',
    showAs: 'Busy',
    bodyContent: '<p>Sensitive agenda: see https://example.invalid/secret-doc for details.</p>',
  },
  // Recurring series: 1 RecurringMaster (must NOT appear) + 4 Occurrence (run-collapse, >2) +
  // 1 Exception (a moved instance, same series — joins the same collapsed group).
  {
    objectId: 'evt-series-master',
    seriesMasterId: STANDUP_SERIES,
    subject: 'Daily Standup',
    startTime: evIso(16, 9, 15),
    endTime: evIso(16, 9, 30),
    organizerName: grace.displayName,
    organizerAddress: grace.email,
    eventType: 'RecurringMaster',
    showAs: 'Busy',
  },
  {
    objectId: 'evt-series-occ-1',
    seriesMasterId: STANDUP_SERIES,
    subject: 'Daily Standup',
    startTime: evIso(16, 9, 15),
    endTime: evIso(16, 9, 30),
    organizerName: grace.displayName,
    organizerAddress: grace.email,
    eventType: 'Occurrence',
    myResponseType: 'Accepted',
    showAs: 'Busy',
  },
  {
    objectId: 'evt-series-occ-2',
    seriesMasterId: STANDUP_SERIES,
    subject: 'Daily Standup',
    startTime: evIso(17, 9, 15),
    endTime: evIso(17, 9, 30),
    organizerName: grace.displayName,
    organizerAddress: grace.email,
    eventType: 'Occurrence',
    myResponseType: 'Accepted',
    showAs: 'Busy',
  },
  {
    objectId: 'evt-series-occ-3',
    seriesMasterId: STANDUP_SERIES,
    subject: 'Daily Standup',
    startTime: evIso(18, 9, 15),
    endTime: evIso(18, 9, 30),
    organizerName: grace.displayName,
    organizerAddress: grace.email,
    eventType: 'Occurrence',
    myResponseType: 'Accepted',
    showAs: 'Busy',
  },
  {
    objectId: 'evt-series-occ-4',
    seriesMasterId: STANDUP_SERIES,
    subject: 'Daily Standup',
    startTime: evIso(19, 9, 15),
    endTime: evIso(19, 9, 30),
    organizerName: grace.displayName,
    organizerAddress: grace.email,
    eventType: 'Occurrence',
    myResponseType: 'Accepted',
    showAs: 'Busy',
  },
  {
    objectId: 'evt-series-exc-1',
    seriesMasterId: STANDUP_SERIES,
    subject: 'Daily Standup (moved)',
    startTime: evIso(20, 10, 0),
    endTime: evIso(20, 10, 15),
    organizerName: grace.displayName,
    organizerAddress: grace.email,
    eventType: 'Exception',
    myResponseType: 'Accepted',
    showAs: 'Busy',
  },
];

// ---- call-history ("call" mapping entity) ----
export interface CallParticipantDef {
  mri: string;
  displayName?: string | null;
}
export interface RecordingLinkDef {
  conversationId: string;
  linkedMessageId: string;
}
export interface CallDef {
  callId: string;
  callType: 'TwoParty' | 'MultiParty';
  callDirection: 'Outgoing' | 'Incoming';
  callState: 'Accepted' | 'Missed' | 'Declined';
  startTime: string;
  durationInMs: number;
  originator: CallParticipantDef;
  target: CallParticipantDef;
  participantList?: CallParticipantDef[];
  groupChatThreadId?: string;
  recordingLink?: RecordingLinkDef;
  hasTranscript?: boolean;
  isDeleted?: boolean;
}

// The study-group conversation + Barbara's welcome message (test/fixture/data.ts's own
// CONVERSATIONS[1]) double as the recording-pivot target below — a real cached message.
const STUDY_GROUP_ID = '19:f1e2d3c4b5a6@thread.v2';
const STUDY_GROUP_WELCOME_MSG_ID = String(CONVERSATIONS[1].messages[1].ts);

export const CALLS: CallDef[] = [
  // TwoParty Incoming Accepted — counterpart resolvable ONLY via the profiles table (never
  // posts a message, so `people` alone would miss her; nameForMri must fall through to profiles).
  {
    callId: 'call-1-incoming-accepted',
    callType: 'TwoParty',
    callDirection: 'Incoming',
    callState: 'Accepted',
    startTime: evIso(9, 8, 0),
    durationInMs: 300_000, // 5m
    originator: { mri: SILENT_PROFILE.mri, displayName: null },
    target: { mri: ada.mri, displayName: null },
  },
  // TwoParty Outgoing Missed — target.displayName null (as in real data); counterpart resolves
  // via the ordinary people/message-sender path (grace has posted messages).
  {
    callId: 'call-2-outgoing-missed',
    callType: 'TwoParty',
    callDirection: 'Outgoing',
    callState: 'Missed',
    startTime: evIso(9, 9, 0),
    durationInMs: 0,
    originator: { mri: ada.mri, displayName: null },
    target: { mri: grace.mri, displayName: null },
  },
  // MultiParty — groupChatThreadId IS a fixture group conversation (chat pivot).
  {
    callId: 'call-3-multiparty',
    callType: 'MultiParty',
    callDirection: 'Outgoing',
    callState: 'Accepted',
    startTime: evIso(9, 10, 0),
    durationInMs: 45_000, // 45s — exercises the humanizeDuration seconds branch
    originator: { mri: ada.mri, displayName: null },
    target: { mri: barbara.mri, displayName: null },
    participantList: [
      { mri: ada.mri, displayName: null },
      { mri: barbara.mri, displayName: null },
      { mri: edsger.mri, displayName: null },
    ],
    groupChatThreadId: STUDY_GROUP_ID,
  },
  // Recorded call whose linkedMessage points at a real fixture message — recording pivot.
  {
    callId: 'call-4-recorded',
    callType: 'TwoParty',
    callDirection: 'Incoming',
    callState: 'Accepted',
    startTime: evIso(9, 11, 0),
    durationInMs: 3_900_000, // 1h05m — exercises the humanizeDuration hours branch
    originator: { mri: radia.mri, displayName: null },
    target: { mri: ada.mri, displayName: null },
    recordingLink: { conversationId: STUDY_GROUP_ID, linkedMessageId: STUDY_GROUP_WELCOME_MSG_ID },
    hasTranscript: true,
  },
  // Deleted call — must be filtered out of list_calls by default.
  {
    callId: 'call-5-deleted',
    callType: 'TwoParty',
    callDirection: 'Outgoing',
    callState: 'Accepted',
    startTime: evIso(9, 12, 0),
    durationInMs: 120_000,
    originator: { mri: ada.mri, displayName: null },
    target: { mri: alan.mri, displayName: null },
    isDeleted: true,
  },
];
