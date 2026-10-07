import { GitCommandFailure, renderDeltaPatch } from './git-diff.js'
import { PrServiceError } from './prs.js'

export const MAX_PR_PATCH_BYTES = 2 * 1024 * 1024

/** GitHub patches omit file headers, which Delta needs to select the syntax. */
export async function renderPrDiff(path: unknown, patch: unknown, width: unknown): Promise<string> {
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f\x7f]/u.test(path)
    || typeof patch !== 'string' || Buffer.byteLength(patch) > MAX_PR_PATCH_BYTES
    || typeof width !== 'number' || !Number.isInteger(width) || width < 60 || width > 500) {
    throw new PrServiceError(400, 'invalid_request', 'Invalid diff path, patch, or width (60–500 columns)')
  }
  // Paths are metadata, never command arguments or filesystem reads. Git-style quoting
  // keeps spaces, quotes, and non-ASCII filenames from changing header interpretation.
  const oldPath = JSON.stringify(`a/${path}`)
  const newPath = JSON.stringify(`b/${path}`)
  try {
    return await renderDeltaPatch(`diff --git ${oldPath} ${newPath}\n--- ${oldPath}\n+++ ${newPath}\n${patch}\n`, width)
  } catch (error) {
    if (error instanceof GitCommandFailure && error.missingBinary) {
      throw new PrServiceError(503, 'tool_missing', 'Delta is not installed or not on the daemon PATH. Install it with brew install git-delta.')
    }
    throw new PrServiceError(502, 'diff_render_failed', error instanceof Error ? error.message : 'Unable to render Delta diff')
  }
}
