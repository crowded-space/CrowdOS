# 05 Event Broker And Socket

## Goal
Create the realtime backbone of the system.

## Tasks
- [ ] Implement `EventBroker` wrapper over `EventEmitter`.
- [ ] Define event names and payload types.
- [ ] Add Socket.io server.
- [ ] Add Socket.io client connection.
- [ ] Forward backend events to frontend.
- [ ] Add message streaming event.
- [ ] Add agent status event.
- [ ] Add typing/thinking event.
- [ ] Add reconnect handling in client store.
- [ ] Add listener cleanup rules.

## Small checks
- [ ] Emit a test event from server.
- [ ] Receive it in browser.
- [ ] Show a new chat message without refresh.

## Done when
- Realtime events can update UI without polling.
- Event types are centralized and typed.
