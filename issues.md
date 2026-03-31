# Open Issues

Discovered during webapp testing (2026-03-30).

## 1. Double response on messages
Claus sends two messages when one is expected. After boot completes, the `convoCortex.askUser` reformulation and a hook or duplicate path both fire, producing two responses to a single prompt.

## 2. Activity tab not updating with full event stream
The Activity tab only shows a subset of events. Should be a comprehensive stream — sense consultations, evaluations, build cycles, gate decisions, planning steps, everything that happens internally.

## 3. Claus out of sync with system state
Claus declares "spec locked, kicking off planning" while senses still have open inquiry questions. Claus lacks awareness of where the system actually is in its flow — it doesn't know when senses have pending questions, when inquiry is still open, when the system has actually reached a transition point. It confabulates progress instead of reflecting actual state.

**Root cause:** Claus operates from its own conversation context + event digest, but doesn't have direct visibility into the sensory cortex's active phase (inquiry open? questions pending? consultation complete?). It needs to be informed of — or able to query — the current system phase and any pending work before narrating transitions.

## 4. Sense questions not properly channeled through Claus
The senses generate inquiry questions during consultation, but these aren't surfaced to the Parsifal through the conversation. Claus asks its own questions independently rather than presenting the sense-generated questions. The Parsifal should see what the senses are actually asking.
