# RoboAgent LLM Gateway Integration (implemented 2026-07-27)

Chat in the IDE now gets its models from the RoboAgent LLM gateway
(`https://www.roboticscorner.tech/roboagent/api/llm`) using the user's
RoboAgent (Supabase) sign-in. No GitHub/Copilot account is required. Users
that sign in via **RoboAgent: Log In** see the gateway's models (currently
DeepSeek V4 Pro; more via the server-side `LLM_MODELS` env) in the chat model
picker under the **RoboAgent** vendor, with full agent mode: streaming, tool
calling, and token accounting.

## How it works

```
chat UI → Copilot participant → RoboAgentLMProvider → OpenAIEndpoint
        → POST https://www.roboticscorner.tech/roboagent/api/llm/chat
          Authorization: Bearer <Supabase access token>
```

The gateway is OpenAI-compatible; the server attaches the actual provider key
(platform key with per-plan daily allowance, or the user's own BYOK key from
the dashboard). Provider keys never reach the IDE.

### How the extension gets the token (security model)

```
RoboAgentLMProvider ─ vscode.authentication.getSession('roboagent', [], { silent: true })
      │  ext host → MainThreadAuthentication: is GitHub.copilot-chat allowed? (product.json
      │  trustedExtensionAuthAccess.roboagent → yes; any other extension → consent prompt)
      ▼
RoboAgentAuthenticationProvider (workbench contrib, src/vs/workbench/contrib/roboagent)
      │  ProxyChannel 'roboagentAuth'
      ▼
RoboAgentAuthMainService.getAccessToken() (main process; refreshes near expiry)
```

The token is only ever handed out through the workbench's authentication
service, which enforces per-extension access. It is deliberately **not**
exposed as a command: a command such as `roboagent.getAccessToken` can be
executed by any installed extension (`vscode.commands.executeCommand`), which
would let a third-party Open VSX extension read - and keep refreshing - the
user's session token. The first draft of this integration did exactly that;
the 2026-09-04 security review replaced it with the provider above.

## Changes in this repo

### Core (src/vs)
- `platform/roboagentAuth/common/roboagentAuthService.ts` — new
  `getAccessToken()` on `IRoboAgentAuthMainService`.
- `platform/roboagentAuth/electron-main/roboagentAuthMainService.ts` — impl:
  tracks `_accessTokenExpiresAt`, refreshes when missing/near expiry
  (`TOKEN_REFRESH_MARGIN_MS`), returns undefined when signed out. A missing
  `expires_in` falls back to 3600s instead of a NaN expiry.
- `workbench/contrib/roboagent/browser/roboagentAuthProvider.ts` — **new**.
  `RoboAgentAuthenticationProvider`: registers the `roboagent` provider with the
  workbench `IAuthenticationService` (declared + live) and serves sessions
  `{ id: roboagent/<userId>, accessToken, account: { id: userId, label: email } }`
  straight from the main-process service (nothing cached). `createSession`
  runs the browser sign-in, `removeSession` signs out, and main-process session
  changes are mirrored as added/changed/removed events (so the Accounts menu
  and extensions stay in sync). Unit tests in `test/browser/roboagentAuthProvider.test.ts`.
- `product.json` — `trustedExtensionAuthAccess.roboagent: ["GitHub.copilot-chat"]`
  pre-trusts the built-in chat extension so no consent prompt appears for it.
- `extensions/roboagent-authentication/` — **removed**. A leftover, never-compiled
  prototype (not in the gulp compilations, no `out/`) that declared the same
  `roboagent` provider id and used a token-in-callback-URL login; keeping it would
  have collided with the core provider and shown a broken "Sign in with RoboAgent"
  entry.

### Vendored Copilot extension (extensions/copilot)
- `src/extension/byok/vscode-node/roboAgentProvider.ts` — **new**. Language-
  model provider `roboagent`: lists models from `GET /api/llm/models` (non-2xx
  is reported as a gateway error), chats through `OpenAIEndpoint` pointed at
  `/api/llm/chat`, token fetched fresh per request via
  `vscode.authentication.getSession('roboagent', [], { silent: true })`. No
  stored API key.
- `src/extension/byok/vscode-node/byokContribution.ts` — registers the
  RoboAgent provider **unconditionally** (the stock BYOK providers stay gated
  on a Copilot token).
- `package.json` — vendor `roboagent` added to `languageModelChatProviders`;
  the `gitHubLoginFailed` welcome panel is disabled (`when: false`).
- Four patches so chat works with zero GitHub auth:
  1. `conversation/vscode-node/conversationFeature.ts` — activates
     unconditionally (was: only when a Copilot token appears; without it the
     default participant never registered and every request failed with
     "No default agent registered").
  2. `conversation/vscode-node/chatParticipants.ts` `switchToBaseModel` —
     non-copilot vendors bail before the `copilot-base` endpoint lookup that
     requires a Copilot token.
  3. `prompt/node/chatMLFetcher.ts` — client-side BYOK endpoints (`isBYOKModel()
     === 1`, which includes the RoboAgent gateway) no longer need a Copilot
     token at all: they authenticate through their own `Authorization` header
     from `getExtraHeaders()`, and the fetcher previously refused to send
     ("key is missing") when neither a `secretKey` nor a Copilot token existed.
     For those endpoints the fetcher also stops calling `getCopilotToken()`,
     which without a GitHub session mints an anonymous Copilot token from
     GitHub's API (`chat.allowAnonymousAccess` defaults to true) or fails with
     telemetry noise on every request. The 402 handler's token refresh is
     best-effort so a gateway "allowance exhausted" reply stays a quota error.
  4. `prompt/vscode-node/endpointProviderImpl.ts` — `'copilot-base'` family
     lookups fall back to a synthetic tokenizer-only endpoint when no Copilot
     token exists (prompt-tsx rendering asks for it even on BYOK requests).
     With a Copilot token present the original error is rethrown, so a real
     CAPI/network failure for a Copilot user is not masked by a fake model.

GitHub-authenticated users are unaffected: every patch keeps the original
path when a Copilot token is present.

## Build & test (dev machine)

```bash
nvm use            # 22.22.1
npm install
npm run watch      # includes watch-copilot
./scripts/code.sh
```

Test matrix:
1. Launch with NO GitHub sign-in **and `chat.allowAnonymousAccess: false`**
   (otherwise an anonymous Copilot token hides auth regressions) → run
   **RoboAgent: Log In** → open chat → the model picker shows "DeepSeek V4 Pro"
   under RoboAgent → send a message → streamed reply. The Accounts menu lists
   the RoboAgent account; no GitHub request is made for the chat turn.
2. Agent mode with a tool-using prompt → tool calls execute (gateway relays
   `tools`/`tool_calls`).
3. Sign out of RoboAgent → request fails with "Sign in to RoboAgent…".
4. Signed into GitHub Copilot too → Copilot models still work side by side.
5. After ~1h idle (token expiry) → next chat still works (auto-refresh).
6. Install any third-party extension that calls
   `vscode.authentication.getSession('roboagent', [])` → the workbench asks
   for consent first; with `{ silent: true }` it gets nothing until allowed.

Server-side counterpart lives in `roboagentweb` (`app/api/llm/*`,
`lib/roboagent/{llm,providers}.ts`); per-user turns land in
`roboagent_usage_events` and show on the dashboard.
