// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasSectionStatus } from './CanvasSectionStatus'

afterEach(cleanup)
const section = { id: 's', title: 'Section', status: 'idea' as const, frames: ['a'] }
describe('section status menu', () => {
  it('shows all statuses, avoids redundant writes, closes on Esc/outside and disables while writing', () => {
    const onChange = vi.fn()
    const view = render(<CanvasSectionStatus section={section} disabled={false} onChange={onChange} />)
    const chip = screen.getByRole('button', { name: 'Section status' })
    fireEvent.click(chip); expect(screen.getAllByRole('menuitemradio')).toHaveLength(5)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Idea' })); expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(chip); fireEvent.keyDown(window, { key: 'Escape' }); expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.click(chip); fireEvent.pointerDown(document.body); expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.click(chip); fireEvent.click(screen.getByRole('menuitemradio', { name: 'In progress' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('in-progress')
    view.rerender(<CanvasSectionStatus section={section} disabled={true} onChange={onChange} />)
    expect(chip).toBeDisabled()
  })
})
