import { normalizeCaptureLineEndings } from './tmux-control.js'

type CompanionOutputSource = {
  capturePane: (sessionId: string, paneId: string) => Promise<Buffer>
  paneCurrentCommand: (paneId: string) => Promise<string>
}

export async function captureRenderedCompanionOutput(
  source: CompanionOutputSource,
  sessionId: string,
  paneId: string,
): Promise<{ command: string; output: string }> {
  const [command, capture] = await Promise.all([
    source.paneCurrentCommand(paneId),
    source.capturePane(sessionId, paneId),
  ])
  return {
    command,
    output: normalizeCaptureLineEndings(capture).toString('utf8'),
  }
}
