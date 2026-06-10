# doover-js

TypeScript client for Doover.

## Exports

### Root (`doover-js`)

- `DooverClient`
- `DooverDataProvider`
- `GatewayClient`
- `RestClient`
- `DooverAuth`, `CookieAuth`, `DooverTokenAuth`
- `AuthProfile`, `DooverAuthError`
- `buildAuth`
- `AgentsApi`, `ChannelsApi`, `MessagesApi`, `AggregatesApi`, `AlarmsApi`, `ConnectionsApi`, `NotificationsApi`, `PermissionsApi`, `ProcessorsApi`, `TurnApi`

### Node subpath (`doover-js/node`)

- `ConfigManager` — file-backed profile store (Node-only, uses `fs`)

## Usage

### Cookie-only browser usage (default)

When no auth inputs are provided, the client uses ambient cookies (`credentials: "include"`). This is the default browser behaviour and matches the original API.

```ts
import { DooverClient } from "doover-js";

const client = new DooverClient({
  dataRestUrl: "https://example.com/api",
  controlApiUrl: "https://example.com/control",
  dataWssUrl: "wss://example.com/gateway",
});

const channels = await client.viewer.getChannels({ agentId: "123" });
```

### Explicit token usage

Pass a token directly to use bearer auth. The client will send `Authorization: Bearer <token>` on every HTTP request and use `credentials: "omit"`.

```ts
import { DooverClient } from "doover-js";

const client = new DooverClient({
  dataRestUrl: "https://example.com/api",
  controlApiUrl: "https://example.com/control",
  dataWssUrl: "wss://example.com/gateway",
  token: "your-access-token",
  refreshToken: "your-refresh-token",
  authServerUrl: "https://auth.example.com",
  authServerClientId: "your-client-id",
});

// Token refresh happens automatically when the token expires
const me = await client.rest.get("/users/me", undefined, client.rest.config.controlApiUrl);
```

### Profile / ConfigManager usage (Node)

Use the `ConfigManager` from the `doover-js/node` subpath to load profiles from `~/.doover/config`, matching pydoover's config format.

```ts
import { DooverClient } from "doover-js";
import { ConfigManager } from "doover-js/node";

const configManager = new ConfigManager(); // reads ~/.doover/config
const client = new DooverClient({
  dataRestUrl: "https://example.com/api",
  controlApiUrl: "https://example.com/control",
  dataWssUrl: "wss://example.com/gateway",
  profile: "production",
  configManager,
});
```

You can also pass an `AuthProfile` instance directly:

```ts
import { DooverClient, AuthProfile } from "doover-js";

const profile = new AuthProfile({
  profile: "custom",
  token: "my-token",
  refreshToken: "my-refresh-token",
  authServerUrl: "https://auth.example.com",
  authServerClientId: "client-id",
});

const client = new DooverClient({
  dataRestUrl: "https://example.com/api",
  controlApiUrl: "https://example.com/control",
  dataWssUrl: "wss://example.com/gateway",
  profile,
});
```

### WebSocket auth behaviour

The auth layer automatically handles websocket authentication:

- **Cookie auth**: Uses the original websocket URL and relies on ambient cookies.
- **Token auth with `webSocketFactory`**: Passes `Authorization: Bearer <token>` via headers.
- **Token auth with standard `WebSocket`**: Appends `?token=<token>` to the websocket URL.

For Node.js websocket clients that support custom headers, provide a `webSocketFactory`:

```ts
import WebSocket from "ws";
import { DooverClient } from "doover-js";

const client = new DooverClient({
  dataRestUrl: "https://example.com/api",
  controlApiUrl: "https://example.com/control",
  dataWssUrl: "wss://example.com/gateway",
  token: "your-token",
  webSocketFactory: ({ url, headers }) => new WebSocket(url, { headers }),
});
```

Reconnections automatically use the latest (potentially refreshed) token.

## Multi-source data (`DataClient`)

### The `DataClient` contract

`DooverClient` now implements the `DataClient` interface — the shared contract for every client type in this library. Any hook or provider that previously accepted a `DooverClient` now accepts any `DataClient`.

```ts
import type { DataClient } from "doover-js";

function useMyData(client: DataClient) {
  return client.channels.listChannels("my-agent");
}
```

### Capability model

Each client advertises what it can do via `getCapabilities()` and the `supports(cap)` helper. Calling an unsupported method throws `UnsupportedCapabilityError`.

```ts
import { UnsupportedCapabilityError } from "doover-js";

if (client.supports("aggregates.write")) {
  await client.aggregates.putAggregate(channelId, data);
} else {
  console.warn("Client does not support aggregate writes");
}
```

### `LocalAgentClient` — LAN / direct access

Connect directly to a local Doover agent without cloud auth:

```ts
import { LocalAgentClient } from "doover-js";

const local = new LocalAgentClient({
  baseUrl: "http://192.168.0.7:49100",
  sourceId: "local:192.168.0.7:49100", // stable id for cache keys
});
const channels = await local.channels.listChannels("my-agent");
```

`LocalAgentClient` exposes a narrowed capability set — reads for agents, channels, messages, aggregates, and the gateway are supported; cloud-only operations (alarms, notifications, permissions, etc.) are not.

### `MultiplexClient` — fan-out reads, routed writes

`MultiplexClient` manages a registry of named sources (cloud or local) and fans reads out across all active sources, merging the results. Writes are routed to the single source that owns the target agent.

```ts
import { MultiplexClient, LocalAgentClient, getDooverClient } from "doover-js";

const mux = new MultiplexClient({
  factory: (d) =>
    d.kind === "cloud"
      ? getDooverClient({ /* cloud config */ })
      : new LocalAgentClient({ baseUrl: `http://${(d.params as any).host}:${(d.params as any).port}`, sourceId: d.id }),
  register: [{ id: "cloud", kind: "cloud" }],
  enable: ["cloud"],
});
mux.setActiveSources(["cloud", { id: "local:192.168.0.7:49100", kind: "local", params: { host: "192.168.0.7", port: 49100 } }]);
const channels = await mux.channels.listChannels("dev7"); // merged cloud + local
mux.on("conflict", (c) => console.warn("source disagreement", c));
```

Use `getLastConflicts()` to inspect the most recent per-key disagreements between sources after a read.

### `__source` provenance

Every datum returned by any `DataClient` carries a `__source` field (type `SourceProvenance`) recording which client returned it, when, and via which transport.

```ts
const ch = await client.channels.getChannel("my-channel");
console.log(ch.__source?.client.id); // e.g. "cloud" or "local:192.168.0.7:49100"
```

### React: hooks, `DooverProvider`, and `useClientStatus`

`DooverProvider` accepts any `DataClient`:

```tsx
import { DooverProvider } from "doover-js/react";
import { MultiplexClient } from "doover-js";

<DooverProvider client={mux}>
  <App />
</DooverProvider>
```

All data hooks gained an optional `sources?: string[]` prop that restricts fan-out to specific sources:

```tsx
const { data } = useChannelAggregate(channelId, { sources: ["local:192.168.0.7:49100"] });
```

The new `useClientStatus()` hook surfaces the connection status of every registered source:

```tsx
import { useClientStatus } from "doover-js/react";

const statuses = useClientStatus();
// statuses is DataClientStatus[] — one entry per registered source
```

`useConnectionState` is soft-deprecated in favour of `useClientStatus`. It still works and remains exported, but new code should prefer `useClientStatus`.

## Architecture

`DooverClient` builds one shared `DooverAuth` instance and injects it into `RestClient`, `DooverDataProvider`, and `GatewayClient`. Token refreshes propagate everywhere automatically.

`DooverDataProvider` preserves the older viewer-oriented interface. `DooverClient` exposes the broader API surface through subclients.

## 0.5.0-alpha.1

- **`DataClient` contract + capability model** — `DooverClient` now implements the `DataClient` interface. Every client type advertises its capability set; unsupported calls throw `UnsupportedCapabilityError`. `AmbiguousWriteError` is raised when a `MultiplexClient` write has more than one candidate source. (Additive, no breaking changes.)
- **`__source` provenance** — every datum carries a `__source: SourceProvenance` field recording which client returned it, when, and via which transport.
- **`LocalAgentClient`** — new client for direct LAN connections to a local Doover agent (no cloud auth required).
- **`MultiplexClient`** — new client that manages a registry of named sources, fans reads out across all active sources, merges results, and routes writes to the owning source.
- **React `sources` option** — all data hooks accept `sources?: string[]` to restrict fan-out to specific sources; query keys are source-dimensioned.
- **`useClientStatus()`** — new react hook that surfaces `DataClientStatus` for each registered source.
- **`useConnectionState` soft-deprecated** — still exported and working; prefer `useClientStatus` for new code.

## Migrating to 0.6.0

`DooverDataProvider` (`client.viewer`) is deprecated in 0.5.0 and removed in 0.6.0. The replacements are subclients on `DooverClient`:

| Viewer method | Replacement |
|---|---|
| `client.viewer.getMe()` | `client.users.getMe()` |
| `client.viewer.getAgents(opts)` | `client.agents.listAgents(opts)` |
| `client.viewer.getChannels(id, opts)` | `client.channels.listChannels(id, opts)` |
| `client.viewer.getChannel(id)` | `client.channels.getChannel(id)` |
| `client.viewer.createChannel(id, name, opts)` | `client.channels.putChannel(id, name, body)` |
| `client.viewer.archiveChannel(id)` | `client.channels.archiveChannel(id)` |
| `client.viewer.unarchiveChannel(id)` | `client.channels.unarchiveChannel(id)` |
| `client.viewer.subscribeToChannel(id, msg, agg, upd?)` | `client.gateway.subscribeToChannel(channel, { onMessage, onAggregate, onMessageUpdate })` — returns an unsubscribe fn |
| `client.viewer.unsubscribeFromChannel(id, cb)` | call the unsubscribe fn returned by `subscribeToChannel` |
| `client.viewer.getAggregate(id)` | `const ch = await client.channels.getChannel(id); ch.aggregate ?? client.aggregates.getAggregate(id)` |
| `client.viewer.updateAggregate(id, data, params)` | `client.aggregates.patchAggregate(id, data, params)` |
| `client.viewer.putAggregate(id, data, params)` | `client.aggregates.putAggregate(id, data, params)` |
| `client.viewer.getMessages(id, opts)` | `client.messages.listMessages(id, { ...opts, order: "asc" })` (omit `order` for raw newest-first server order) |
| `client.viewer.deleteMessage(id, msgId)` | `client.messages.deleteMessage(id, msgId)` |
| `client.viewer.sendMessage(id, data)` | `client.messages.postMessage(id, { data })` |
| `client.viewer.sendRPC(id, req, opts)` | `client.rpc.send(id, req, opts)` |
| `client.viewer.getChannelSubscriptions(id)` | `client.connections.getChannelSubscriptions(id)` |
| `client.viewer.getAgentConnections(id)` | `client.connections.getAgentConnections(id)` |
| `client.viewer.getIdentifierFromPath(p, s)` | `getIdentifierFromPath(p, s)` (free function — already exported) |
| `client.viewer.getAgentInfo(id)` | **dropped, no replacement** — was a synthesized stub with no network call |

`*Api` resource methods accept either positional arguments or a `ChannelIdentifier` / `{ agentId }` object on every call form.

`client.rpc.send` adds optional `signal: AbortSignal` and `timeoutMs: number` and rejects with `DooverRpcError` (with `.status` and `.request`) instead of the bare status string.
