/**
 * Tool calling through both adapters, against recorded response shapes. No
 * request leaves the process: every fetch here is a fake.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  call,
  callStream,
  parseRegistry,
  DEFAULT_REGISTRY_YAML,
  type ConversationMessage,
  type ToolDefinition,
} from './index.js';

const registry = parseRegistry(DEFAULT_REGISTRY_YAML);

const readFile: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file in the repository.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

/** A conversation one tool round deep, in the neutral shape. */
const conversation: ConversationMessage[] = [
  { role: 'user', content: 'What is in README.md?' },
  {
    role: 'assistant',
    content: [
      {
        type: 'reasoning',
        adapter: 'anthropic',
        data: { type: 'thinking', thinking: '', signature: 'sig-1' },
      },
      { type: 'text', text: 'Reading it.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', toolUseId: 'toolu_1', content: '# app', isError: false }],
  },
];

function capture() {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const respond = (body: unknown) =>
    (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
    }) as unknown as typeof fetch;
  return { seen, respond };
}

const sse = (chunks: string[]) =>
  (async () =>
    ({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const c of chunks) controller.enqueue(enc.encode(c));
          controller.close();
        },
      }),
    }) as unknown as Response) as unknown as typeof fetch;

const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

describe('anthropic tool calling', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('sends tools as input_schema and tool rounds as tool_use / tool_result blocks', async () => {
    const { seen, respond } = capture();
    await call(
      registry,
      'anthropic/claude-haiku-4-5',
      { messages: conversation, tools: [readFile], system: 'sys' },
      respond({
        content: [{ type: 'text', text: 'It says app.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 3 },
      })
    );
    const body = seen[0].body;
    expect(body.tools).toEqual([
      {
        name: 'read_file',
        description: 'Read a file in the repository.',
        input_schema: readFile.inputSchema,
      },
    ]);
    expect(body.tool_choice).toBeUndefined();
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toEqual({ role: 'user', content: 'What is in README.md?' });
    // The thinking block goes back exactly as it came, first.
    expect(messages[1].content).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'text', text: 'Reading it.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } },
    ]);
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '# app' },
    ]);
  });

  it('reads tool_use blocks, the stop reason and keeps thinking opaque', async () => {
    const { respond } = capture();
    const res = await call(
      registry,
      'anthropic/claude-haiku-4-5',
      { prompt: 'go', tools: [readFile] },
      respond({
        content: [
          { type: 'thinking', thinking: '', signature: 'abc' },
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'toolu_9', name: 'read_file', input: { path: 'a.ts' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      })
    );
    expect(res.stopReason).toBe('tool_use');
    expect(res.text).toBe('Let me look.');
    expect(res.toolCalls).toEqual([{ id: 'toolu_9', name: 'read_file', input: { path: 'a.ts' } }]);
    expect(res.content[0]).toEqual({
      type: 'reasoning',
      adapter: 'anthropic',
      data: { type: 'thinking', thinking: '', signature: 'abc' },
    });
    // Tokens and cost are still recorded for a tool turn.
    expect(res.costUsd).toBe(1);
  });

  it('assembles a streamed tool call from input_json_delta fragments', async () => {
    const texts: string[] = [];
    const res = await callStream(
      registry,
      'anthropic/claude-haiku-4-5',
      { prompt: 'go', tools: [readFile] },
      (t) => texts.push(t),
      sse([
        frame({
          type: 'message_start',
          message: { usage: { input_tokens: 20, output_tokens: 1 } },
        }),
        frame({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
        frame({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'hmm' },
        }),
        frame({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'SIG' },
        }),
        frame({ type: 'content_block_stop', index: 0 }),
        frame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
        frame({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'Reading.' },
        }),
        frame({ type: 'content_block_stop', index: 1 }),
        frame({
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'toolu_2', name: 'read_file', input: {} },
        }),
        frame({
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"pa' },
        }),
        // A frame split across two reads.
        'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"th\\": \\"src/x.ts\\"}"}}',
        '\n\n',
        frame({ type: 'content_block_stop', index: 2 }),
        frame({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 42 },
        }),
        frame({ type: 'message_stop' }),
      ])
    );
    expect(texts).toEqual(['Reading.']);
    expect(res.toolCalls).toEqual([
      { id: 'toolu_2', name: 'read_file', input: { path: 'src/x.ts' } },
    ]);
    expect(res.stopReason).toBe('tool_use');
    expect(res.content[0]).toEqual({
      type: 'reasoning',
      adapter: 'anthropic',
      data: { type: 'thinking', thinking: 'hmm', signature: 'SIG' },
    });
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 42 });
  });

  it('flags tool input that is not valid JSON instead of guessing', async () => {
    const res = await callStream(
      registry,
      'anthropic/claude-haiku-4-5',
      { prompt: 'go', tools: [readFile] },
      () => undefined,
      sse([
        frame({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't', name: 'read_file', input: {} },
        }),
        frame({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path": "a' },
        }),
        frame({
          type: 'message_delta',
          delta: { stop_reason: 'max_tokens' },
          usage: { output_tokens: 5 },
        }),
      ])
    );
    expect(res.stopReason).toBe('max_tokens');
    expect(res.toolCalls[0]).toEqual({
      id: 't',
      name: 'read_file',
      input: {},
      inputError: '{"path": "a',
    });
  });

  it('records an unpriced model as unknown cost on a tool turn', async () => {
    const { respond } = capture();
    const res = await call(
      registry,
      'anthropic/claude-unlisted',
      { prompt: 'go', tools: [readFile] },
      respond({
        content: [{ type: 'tool_use', id: 't', name: 'read_file', input: { path: 'x' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 5 },
      })
    );
    expect(res.costUsd).toBeNull();
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 5 });
  });

  it('sends tool_choice none when asked', async () => {
    const { seen, respond } = capture();
    await call(
      registry,
      'anthropic/claude-haiku-4-5',
      { prompt: 'go', tools: [readFile], toolChoice: 'none' },
      respond({
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    );
    expect(seen[0].body.tool_choice).toEqual({ type: 'none' });
  });
});

describe('openai-compat tool calling', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('sends function tools, tool_calls with string arguments, and one tool message per result', async () => {
    const { seen, respond } = capture();
    await call(
      registry,
      'deepseek/deepseek-chat',
      { messages: conversation, tools: [readFile], system: 'sys' },
      respond({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    );
    const body = seen[0].body;
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file in the repository.',
          parameters: readFile.inputSchema,
        },
      },
    ]);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'What is in README.md?' },
      {
        role: 'assistant',
        content: 'Reading it.',
        // Anthropic's thinking is not sent to another vendor.
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: '# app' },
    ]);
  });

  it('reads tool_calls, parses their arguments, and keeps reasoning_content for the next turn', async () => {
    const { seen, respond } = capture();
    const res = await call(
      registry,
      'deepseek/deepseek-chat',
      { prompt: 'go', tools: [readFile] },
      respond({
        choices: [
          {
            message: {
              content: null,
              reasoning_content: 'I should read it.',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"a.md"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
      })
    );
    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', input: { path: 'a.md' } }]);
    expect(res.costUsd).toBeCloseTo(0.27, 6);

    // The turn goes back with its reasoning, and no content beside the calls.
    await call(
      registry,
      'deepseek/deepseek-chat',
      {
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: res.content },
        ],
        tools: [readFile],
      },
      respond({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    );
    expect((seen[1].body.messages as unknown[])[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.md"}' },
        },
      ],
      reasoning_content: 'I should read it.',
    });
  });

  it('treats a turn with tool calls as a tool turn even when the server says "stop"', async () => {
    const { respond } = capture();
    const res = await call(
      registry,
      'deepseek/deepseek-chat',
      { prompt: 'go', tools: [readFile] },
      respond({
        choices: [
          {
            message: {
              tool_calls: [{ id: 'c', function: { name: 'read_file', arguments: '{}' } }],
            },
            finish_reason: 'stop',
          },
        ],
      })
    );
    expect(res.stopReason).toBe('tool_use');
  });

  it('assembles streamed tool calls from indexed argument fragments', async () => {
    const res = await callStream(
      registry,
      'deepseek/deepseek-chat',
      { prompt: 'go', tools: [readFile] },
      () => undefined,
      sse([
        frame({ choices: [{ delta: { role: 'assistant', content: 'Two files.' } }] }),
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_a',
                    type: 'function',
                    function: { name: 'read_file', arguments: '' },
                  },
                ],
              },
            },
          ],
        }),
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 1,
                    id: 'call_b',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":' },
                  },
                ],
              },
            },
          ],
        }),
        frame({
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] } },
          ],
        }),
        frame({
          choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"b"}' } }] } }],
        }),
        frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        frame({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 9 } }),
        'data: [DONE]\n\n',
      ])
    );
    expect(res.text).toBe('Two files.');
    expect(res.toolCalls).toEqual([
      { id: 'call_a', name: 'read_file', input: { path: 'a' } },
      { id: 'call_b', name: 'read_file', input: { path: 'b' } },
    ]);
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 9 });
  });

  it('retries with max_completion_tokens when the server refuses max_tokens', async () => {
    const bodies: Record<string, unknown>[] = [];
    process.env.OPENAI_API_KEY = 'test-openai-key';
    const res = await call(registry, 'openai/gpt-5.2', { prompt: 'go', maxTokens: 500 }, (async (
      _url: string,
      init: RequestInit
    ) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if ('max_tokens' in body) {
        return {
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({
              error: {
                message:
                  "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.",
              },
            }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: 'hi' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
      } as Response;
    }) as unknown as typeof fetch);
    expect(res.text).toBe('hi');
    expect(bodies[1].max_completion_tokens).toBe(500);
    expect(bodies[1].max_tokens).toBeUndefined();
  });
});
