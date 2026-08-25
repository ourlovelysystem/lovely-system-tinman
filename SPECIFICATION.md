# Tinman — Initial Application Specification

**Status:** Candidate specification, first increment  
**Application:** Tinman  
**Repository:** `ourlovelysystem/lovely-system-tinman`  
**Intended host:** `tinman.ourlovelysystem.org`

## 1. Purpose

Tinman is a voice-first listening system for messages directed toward Our Lovely System. Its first message type is the appeal.

Tinman does not treat the appeal as a request to be absorbed by process. The voice message is the primary object. Human listening is an institutional act that must occur before an appeal can change official state.

Working line:

> A listening machine in search of a heart.

## 2. Application and route model

Tinman is one application and one codebase.

| Route | Initial behavior |
|---|---|
| `/` | Opening ritual, recording browser, and metadata search |
| `/appeals/` | Recording control configured to create an appeal |
| `/accolades/` | Reserved future behavior; not part of the first increment |

Routes configure the recording control and determine message tagging and resolution behavior. They do not identify separate applications, codebases, or deployments.

## 3. Opening ritual

On first arrival, the landing page presents itself as a rusty, seized mechanism rather than a conventional interface.

- The ordinary pointer is replaced visually by an oil can.
- Three distinct bearings appear in need of oil.
- Each bearing is an independently operable control.
- Oiling a bearing visibly changes its state.
- After all three bearings have been oiled, the page records completion for the browser session and reloads.
- The reloaded presentation is a clean metallic interface.
- A visible control permits the mechanism to be rusted again for replay and testing.
- Keyboard and coarse-pointer users must retain a usable way to activate each bearing.

The ritual is functional, not merely illustrative: the clean interface is unavailable until the three oiling actions are completed.

## 4. Appeal capture

The first recording form provides:

- public self-identification;
- Record;
- Stop;
- Replay;
- rewind ten seconds;
- fast-forward ten seconds; and
- Submit.

Authentication, registration, and verification of the asserted identity are not requirements of this increment.

An appeal arrives as a voice message. Transcription is not a substitute for the original recording.

## 5. Message browser

The root interface provides the recording browser and metadata search.

The browser should be able to display or search on metadata that actually exists, including:

- public self-identification;
- message type;
- submission time;
- duration;
- response count;
- listener information;
- internal-listening status; and
- transcription status.

Confirmed sorting dimensions are time and response count. The earlier phrase “by time, by time and by responses” is preserved as an unresolved repetition rather than silently converted into a new requirement.

## 6. Listening requirements

- Other customers may listen to appeals and create public review tracks.
- Multiple internal humans must listen before an appeal can change official state.
- Customer listening does not substitute for required internal listening.
- If appeals remain unheard, the system surfaces that fact rather than concealing it in a queue.
- Surfaced listening information should include appeal age, customer listens, internal listens, and required-versus-completed internal listening.
- Live appeal response, when available, uses multiple human listeners.
- No script or canned apology is prescribed.
- When live response is unavailable, the original appeal is recorded and later presented to multiple humans. Their review recordings and annotations remain accessible to the appellant.

## 7. Public review and transcription gate

- Customer listeners may record outward-facing review tracks.
- Review tracks are public and identify the listener using the listener’s outward-facing identifier.
- An appeal may be transcribed only after three qualifying appeal-review tracks have been recorded and publicly posted.
- After the gate is satisfied, the transcript is displayed with the original recording, review tracks, listeners, outward-facing identifiers, and annotations.

**Unresolved:** whether the three qualifying tracks must be internal reviews, customer reviews, or a defined combination. No implementation may silently choose among these alternatives.

## 8. Appeal outcome and exit

A human appeal terminus may be an explicit refusal, including:

> Sorry. Tough shit. We’ll do it again next time.

The system does not promise a favorable resolution. It promises visible human listening and an honest terminus.

After response, the appellant may choose:

- Join us;
- Go fuck yourself; or
- Something else.

“Something else” remains open and must not be reduced to institutional choices.

The escape hatch guarantees exit. A person who leaves owes no explanation and must not be asked to return and explain. The system assumes the answer to “Why are you leaving?” is “Because you SUCK!” Departure and nonresponse are responses.

## 9. Consent and recording

- Recording requires explicit consent.
- A responder may reserve discretion to record only after consent is established.
- Public review and transcription must not erase access to the original voice artifact.

## 10. Candidate founding edict

> Before a lovely system designs a process, it should design a process to appeal process.

This is presented for consideration, not as a mandate. Our Lovely System will seek to comply.

## 11. Explicit exclusions from this increment

- Accolade behavior beyond reserving the route.
- Email attachment ingestion beyond recognizing it as a possible future enhancement.
- A fabricated workflow routing email attachments into the recording collection.
- Automated moral judgment.
- Identity verification.
- A final classifier taxonomy or classifier authority.
- Resolution of the qualifying-review-track ambiguity.
- The separate Our Lovely Justice System, KTLO house, credential, honor, prison, and restitution systems.

## 12. Current implementation boundary

The repository currently implements the opening ritual and the clean metallic landing interface. The recording control, durable message storage, browser, listening ledger, review tracks, classifier, transcription gate, and appeal state machine remain future increments.

## 13. Acceptance criteria for the opening ritual

1. A new browser session opens on the rusty presentation.
2. A visual oil can follows fine-pointer movement.
3. Three distinct oil targets are visible and operable.
4. Each activation produces immediate visual acknowledgement and updates the remaining count.
5. The clean interface is not presented before all three targets are activated.
6. The third activation triggers a reload into the metallic interface.
7. The clean interface identifies Tinman and exposes the appeal and message-browser destinations.
8. “Let the mechanism rust again” restores the opening ritual.
