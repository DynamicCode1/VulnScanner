import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchReport, streamSse } from './api'

function respond(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
}

function events(text: string) {
  return new Response(text, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchReport', () => {
  it('treats only 404 as a cache miss', async () => {
    respond(new Response(null, { status: 404 }))
    expect(await fetchReport()).toBeNull()
    respond(new Response(null, { status: 500 }))
    await expect(fetchReport()).rejects.toThrow('500')
  })

  it('forwards cancellation and loads report metadata', async () => {
    const signal = new AbortController().signal
    const report = { meta: { target: 'http://localhost:3000' } }
    respond(Response.json(report))
    expect(await fetchReport(signal)).toEqual(report)
    expect(fetch).toHaveBeenCalledWith('/api/report', { signal })
  })

  it.each([null, {}, { meta: null }, { meta: { target: 123 } }])('rejects invalid cached metadata: %j', async (value) => {
    respond(Response.json(value))
    await expect(fetchReport()).rejects.toThrow('saved report is invalid')
  })

  it('propagates network and JSON errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failed')))
    await expect(fetchReport()).rejects.toThrow('Network failed')
    respond(new Response('{'))
    await expect(fetchReport()).rejects.toThrow()
  })
})

describe('streamSse', () => {
  it('rejects HTTP failures and non-SSE success responses', async () => {
    respond(Response.json({ error: 'Unavailable' }, { status: 503 }))
    await expect(streamSse('/api/report', {}, vi.fn())).rejects.toThrow('Unavailable')
    respond(new Response('<html>Not an event stream</html>', { headers: { 'content-type': 'text/html' } }))
    await expect(streamSse('/api/report', {}, vi.fn())).rejects.toThrow('did not return an event stream')
  })

  it('preserves chat and scan events while skipping heartbeats', async () => {
    const payloads = [{ type: 'delta', text: 'Hello' }, { type: 'result', index: 0 }, { type: 'done' }]
    const response = events(': ping\n\n' + payloads.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
    respond(response)
    const receive = vi.fn()
    await streamSse('/api/agent', {}, receive)
    expect(receive.mock.calls.map(([event]) => event)).toEqual(payloads)
    expect(response.body?.locked).toBe(false)
  })

  it('does not swallow callback exceptions and releases the reader', async () => {
    const response = events('data: {"type":"done"}\n\n')
    respond(response)
    await expect(streamSse('/api/report', {}, () => { throw new Error('Callback failed') })).rejects.toThrow('Callback failed')
    expect(response.body?.locked).toBe(false)
  })

  it('rejects malformed JSON events', async () => {
    respond(events('data: {invalid}\n\n'))
    await expect(streamSse('/api/report', {}, vi.fn())).rejects.toThrow('invalid event')
  })

  it('cancels and unlocks a stalled body when aborted', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/event-stream' } })
    respond(response)
    const controller = new AbortController()
    const result = streamSse('/api/report', {}, vi.fn(), controller.signal)
    const rejection = expect(result).rejects.toThrow()
    await Promise.resolve()
    controller.abort()
    await rejection
    expect(cancel).toHaveBeenCalled()
    expect(response.body?.locked).toBe(false)
  })

  it('reassembles split frames without dropping events', async () => {
    const encoder = new TextEncoder()
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"sta'))
        controller.enqueue(encoder.encode('tus","text":"Working"}\n'))
        controller.enqueue(encoder.encode('\ndata: {"type":"done"}\n\n'))
        controller.close()
      },
    }), { headers: { 'content-type': 'text/event-stream' } })
    respond(response)
    const receive = vi.fn()
    await streamSse('/api/report', {}, receive)
    expect(receive.mock.calls.map(([event]) => event)).toEqual([{ type: 'status', text: 'Working' }, { type: 'done' }])
  })
})
