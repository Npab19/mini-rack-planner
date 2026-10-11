import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestAddAtU, useAddAtUAvailable, useAddAtURequest } from './addAtURequest'
import { createCommandChannel } from './commandChannel'
import { requestFit, subscribeFitRequest, useFitRequest } from './fitRequest'

afterEach(cleanup)

describe('command channels', () => {
  it('run every registered handler and say whether anyone listened', () => {
    const channel = createCommandChannel()
    expect(channel.request()).toBe(false)
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = channel.subscribe(first)
    const stopSecond = channel.subscribe(second)
    expect(channel.available()).toBe(true)
    expect(channel.request()).toBe(true)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    stopFirst()
    stopFirst()
    expect(channel.request()).toBe(true)
    expect(first).toHaveBeenCalledTimes(1)
    stopSecond()
    expect(channel.available()).toBe(false)
    expect(channel.request()).toBe(false)
  })

  it('run only the latest handler when exclusive (one request, one dialog)', () => {
    const channel = createCommandChannel({ exclusive: true })
    const shell = vi.fn()
    const rack = vi.fn()
    const stopShell = channel.subscribe(shell)
    const stopRack = channel.subscribe(rack)
    expect(channel.request()).toBe(true)
    expect(rack).toHaveBeenCalledTimes(1)
    expect(shell).not.toHaveBeenCalled()
    stopRack()
    channel.request()
    expect(shell).toHaveBeenCalledTimes(1)
    stopShell()
    expect(channel.request()).toBe(false)
  })

  it('count the same handler registered twice as two registrations', () => {
    const channel = createCommandChannel()
    const handler = vi.fn()
    const stop = channel.subscribe(handler)
    channel.subscribe(handler)
    stop()
    expect(channel.available()).toBe(true)
    channel.request()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('let a mounted component handle fit requests with its latest handler', () => {
    const calls: string[] = []
    const { rerender, unmount } = renderHook(
      ({ label }) => useFitRequest(() => calls.push(label)),
      {
        initialProps: { label: 'first' },
      },
    )
    rerender({ label: 'second' })
    expect(requestFit()).toBe(true)
    expect(calls).toEqual(['second'])
    unmount()
    expect(requestFit()).toBe(false)
    const stop = subscribeFitRequest(() => calls.push('outside React'))
    requestFit()
    stop()
    expect(calls).toEqual(['second', 'outside React'])
  })

  it('show "Add at U…" only while a handler is registered', () => {
    const open = vi.fn()
    function Offer() {
      useAddAtURequest(open)
      return null
    }
    function Probe() {
      return <p>{useAddAtUAvailable() ? 'offered' : 'not offered'}</p>
    }
    const { rerender } = render(
      <>
        <Probe />
        <Offer />
      </>,
    )
    expect(screen.getByText('offered')).toBeInTheDocument()
    act(() => {
      expect(requestAddAtU()).toBe(true)
    })
    expect(open).toHaveBeenCalledTimes(1)
    rerender(<Probe />)
    expect(screen.getByText('not offered')).toBeInTheDocument()
    expect(requestAddAtU()).toBe(false)
  })
})
