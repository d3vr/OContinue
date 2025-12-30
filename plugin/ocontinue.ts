import type { Plugin } from "@opencode-ai/plugin"
import { join } from "path"
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs"

interface SessionState {
  active: boolean
  iteration: number
  maxIterations: number
  completionPromise: string
  startedAt: string
  prompt: string
}

interface OContinueState {
  sessions: Record<string, SessionState>
}

export const OContinue: Plugin = async ({ client, directory }) => {
  const stateFile = join(directory, ".opencode", "ocontinue-state.json")
  const logFile = join(directory, ".opencode", "ocontinue.log")

  function log(message: string): void {
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] ${message}\n`
    appendFileSync(logFile, line)
  }

  async function showToast(
    title: string,
    message: string,
    variant: "info" | "success" | "warning" | "error" = "info",
  ): Promise<void> {
    try {
      await client.tui.showToast({
        body: { title, message, variant, duration: 3000 },
      })
    } catch {
      // TUI might not be available (headless mode)
    }
  }

  function readState(): OContinueState {
    try {
      if (!existsSync(stateFile)) return { sessions: {} }
      return JSON.parse(readFileSync(stateFile, "utf-8"))
    } catch {
      return { sessions: {} }
    }
  }

  function writeState(state: OContinueState): void {
    writeFileSync(stateFile, JSON.stringify(state, null, 2))
  }

  function getSessionState(sessionID: string): SessionState | null {
    return readState().sessions[sessionID] ?? null
  }

  function updateSessionState(sessionID: string, updates: Partial<SessionState>): void {
    const state = readState()
    state.sessions[sessionID] = { ...state.sessions[sessionID], ...updates } as SessionState
    writeState(state)
  }

  function deleteSessionState(sessionID: string): void {
    const state = readState()
    delete state.sessions[sessionID]
    writeState(state)
  }

  function extractTextFromParts(parts: Array<{ type: string; text?: string }>): string {
    return parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n")
  }

  log("Plugin loaded")

  return {
    // HOOK 1: Intercept messages to detect start/stop tags
    "chat.message": async (input, output) => {
      const text = extractTextFromParts(output.parts as any)

      // Check for START tag
      const startMatch = text.match(/<ocontinue-start\s+max="([^"]*)"\s+promise="([^"]*)">[\s\S]*?<\/ocontinue-start>/)

      if (startMatch) {
        const [fullMatch, maxStr, promiseStr] = startMatch
        // Extract prompt from between tags (handle whitespace)
        const promptMatch = fullMatch.match(/<ocontinue-start[^>]*>([\s\S]*?)<\/ocontinue-start>/)
        const prompt = promptMatch?.[1]?.trim() ?? ""

        // Fix: Handle empty optional params with proper defaults
        const maxIterations = maxStr?.trim() ? parseInt(maxStr, 10) : 20
        const completionPromise = promiseStr?.trim() || "DONE"

        updateSessionState(input.sessionID, {
          active: true,
          iteration: 1,
          maxIterations,
          completionPromise,
          startedAt: new Date().toISOString(),
          prompt,
        })

        log(`Loop started for session ${input.sessionID} - Max: ${maxIterations}, Promise: "${completionPromise}"`)
        await showToast("OContinue", `Loop started (max ${maxIterations} iterations)`, "info")

        // Transform message to clean prompt + instructions
        output.parts = [
          {
            type: "text",
            text: `${prompt}

---
Signal completion by including <promise>${completionPromise}</promise> when the task is fully complete.`,
          },
        ]
        return
      }

      // Check for STOP tag
      if (text.includes("<ocontinue-stop")) {
        const state = getSessionState(input.sessionID)
        if (state?.active) {
          log(`Loop manually stopped at iteration ${state.iteration}/${state.maxIterations}`)
          await showToast("OContinue", `Loop stopped at iteration ${state.iteration}`, "warning")
          deleteSessionState(input.sessionID)
          output.parts = [
            {
              type: "text",
              text: `OContinue loop stopped at iteration ${state.iteration} of ${state.maxIterations}.`,
            },
          ]
        } else {
          output.parts = [
            {
              type: "text",
              text: "No active OContinue loop for this session.",
            },
          ]
        }
        return
      }
    },

    // HOOK 2: Transform messages before sending to model
    "experimental.chat.messages.transform": async (input, output) => {
      for (const msg of output.messages) {
        if (msg.info.role !== "user") continue

        for (const part of msg.parts as any[]) {
          if (part.type !== "text" || !part.text) continue

          // Check for ocontinue-start tag
          const match = part.text.match(
            /<ocontinue-start\s+max="[^"]*"\s+promise="[^"]*">([\s\S]*?)<\/ocontinue-start>/,
          )
          if (match) {
            const [, prompt] = match
            const state = getSessionState(msg.info.sessionID)
            const promise = state?.completionPromise || "DONE"

            // Transform what the model sees
            part.text = `${prompt.trim()}

---
Signal completion by including <promise>${promise}</promise> when the task is fully complete.`
          }
        }
      }
    },

    // HOOK 3: Handle events (session.error for aborts, session.idle for continuation)
    event: async ({ event }) => {
      // Handle user abort
      if (event.type === "session.error") {
        const props = (event as any).properties
        if (props?.error?.name === "MessageAbortedError") {
          const sessionID = props.sessionID
          if (!sessionID) return

          const state = getSessionState(sessionID)
          if (state?.active) {
            log(`Loop aborted by user at iteration ${state.iteration}/${state.maxIterations}`)
            await showToast("OContinue", "Loop aborted by user", "warning")
            deleteSessionState(sessionID)
          }
        }
        return
      }

      // Handle session idle - continue loop
      if (event.type !== "session.idle") return

      const sessionID = (event as any).properties?.sessionID
      if (!sessionID) return

      const sessionState = getSessionState(sessionID)
      if (!sessionState?.active) return

      // Fetch messages to check last assistant response
      const messages = await client.session.messages({ path: { id: sessionID } })
      const assistantMessages = (messages.data ?? []).filter((m: any) => m.info?.role === "assistant")
      const lastAssistant = assistantMessages[assistantMessages.length - 1]

      // Extract text from last assistant message
      let responseText = ""
      if (lastAssistant?.parts) {
        responseText = (lastAssistant.parts as any[])
          .filter((p) => p.type === "text")
          .map((p) => p.content ?? p.text ?? "")
          .join("\n")
      }

      // Check for completion promise
      const promiseRegex = new RegExp(`<promise>${sessionState.completionPromise}</promise>`, "i")
      if (promiseRegex.test(responseText)) {
        log(`Session ${sessionID} completed! Promise fulfilled at iteration ${sessionState.iteration}`)
        await showToast("OContinue", `Completed at iteration ${sessionState.iteration}`, "success")
        deleteSessionState(sessionID)
        return
      }

      // Check max iterations
      if (sessionState.iteration >= sessionState.maxIterations) {
        log(`Session ${sessionID} reached max iterations (${sessionState.maxIterations})`)
        await showToast("OContinue", `Max iterations reached (${sessionState.maxIterations})`, "warning")
        deleteSessionState(sessionID)
        return
      }

      // Continue the loop
      const nextIteration = sessionState.iteration + 1
      updateSessionState(sessionID, { iteration: nextIteration })

      log(`Continuing iteration ${nextIteration}/${sessionState.maxIterations}`)

      // Send continuation prompt
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [
            {
              type: "text",
              text: `${sessionState.prompt}

---
Signal completion by including <promise>${sessionState.completionPromise}</promise> when the task is fully complete.`,
            },
          ],
        },
      })
    },
  }
}
