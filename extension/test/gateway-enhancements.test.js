const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { parse: parseToml } = require('smol-toml');
const { resolveAnthropicGatewayModel } = require('../out/services/anthropicModelMapping');
const { buildAnthropicGatewayModelsResponse } = require('../out/services/anthropicGatewayModels');
const { shouldDisableCodexWebSearch } = require('../out/services/codexWebSearchPolicy');
const {
  buildCodexModelCatalogDocument,
  inferCodexContextWindow,
} = require('../out/services/codexModelCatalog');
const { upstreamHealth } = require('../out/services/gatewayFailover');
const {
  shouldShowProviderModelConfiguration,
  resolveManualConfigSyncMode,
} = require('../out/services/manualConfigSync');
const {
  inferApiKindFromBaseUrl,
} = require('../out/aiCli/officialEndpoints');
const {
  fetchProviderModels,
} = require('../out/services/claudeCodeModels');
const {
  formatGatewayClaudeModels,
  isFiblabLlmBase,
} = require('../out/services/webConfigGatewayImport');
const {
  pythonHasAgentsociety2,
} = require('../out/services/agentsocietyPythonResolver');

test('URL classification only inspects parsed host and path components', () => {
  assert.equal(
    inferApiKindFromBaseUrl('https://evil.example/siliconflow.cn/v1'),
    'anthropic'
  );
  assert.equal(
    inferApiKindFromBaseUrl('https://api.siliconflow.cn/v1'),
    'openai'
  );
  assert.equal(
    inferApiKindFromBaseUrl('https://llmapi.fiblab.net/v1'),
    'openai'
  );
  assert.equal(
    inferApiKindFromBaseUrl('https://gateway.example/compatible-mode/v1'),
    'openai'
  );
  assert.equal(isFiblabLlmBase('not-a-url-llmapi.fiblab.net'), false);
  assert.equal(isFiblabLlmBase('https://llmapi.fiblab.net/v1'), true);
});

test('provider model fetch falls back to Node HTTP when extension-host fetch fails', async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/v1/models');
    assert.equal(request.headers.authorization, 'Bearer test-key');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };

  try {
    const result = await fetchProviderModels(
      `http://127.0.0.1:${address.port}/v1`,
      'test-key',
      'openai'
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, [{ id: 'test-model' }]);
    assert.equal(result.apiKind, 'openai');
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('gateway import summary formats Claude role models', () => {
  assert.equal(
    formatGatewayClaudeModels({
      sonnetModel: 'sonnet-upstream',
      opusModel: 'opus-upstream',
      fableModel: '',
      haikuModel: 'haiku-upstream',
    }),
    'sonnet-upstream · opus-upstream · haiku-upstream'
  );
  assert.equal(formatGatewayClaudeModels({}), '-');
});

test('Python discovery never evaluates configured paths in a shell', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'as2-python-resolver-'));
  const marker = path.join(tempDir, 'shell-evaluated');
  const maliciousPath = `python$(touch ${marker})`;

  try {
    assert.equal(pythonHasAgentsociety2(maliciousPath), false);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('new provider editor always exposes model configuration', () => {
  assert.equal(shouldShowProviderModelConfiguration(true), true);
  assert.equal(shouldShowProviderModelConfiguration(false), true);
});

test('manual config sync never starts a stopped gateway', () => {
  assert.equal(resolveManualConfigSyncMode(false, false), 'direct');
  assert.equal(resolveManualConfigSyncMode(true, true), 'gateway');
  assert.throws(
    () => resolveManualConfigSyncMode(true, false),
    /gateway_not_running/
  );
});

test('resolveAnthropicGatewayModel maps 1M sonnet to the same upstream model', () => {
  const mapped = resolveAnthropicGatewayModel('claude-sonnet-4-6[1M]', {
    sonnetModel: 'glm-5',
    declareSonnet1m: true,
  });
  assert.equal(mapped, 'glm-5');
});

test('resolveAnthropicGatewayModel maps fable role independently', () => {
  const mapped = resolveAnthropicGatewayModel('claude-fable-5[1M]', {
    fableModel: 'glm-5.1',
    opusModel: 'glm-5.1',
    declareFable1m: true,
  });
  assert.equal(mapped, 'glm-5.1');
  const unavailable = resolveAnthropicGatewayModel('claude-fable-5', {
    opusModel: 'glm-opus',
  });
  assert.equal(unavailable, 'claude-fable-5');
});

test('Claude to OpenAI only emits valid reasoning effort values', () => {
  const { translateAnthropicMessagesToOpenAiChat } = require('../out/services/anthropicOpenAiBridge');
  const valid = translateAnthropicMessagesToOpenAiChat(
    { messages: [], output_config: { effort: 'max' } },
    'gpt-5'
  );
  const invalid = translateAnthropicMessagesToOpenAiChat(
    { messages: [], output_config: { effort: 'turbo' } },
    'gpt-5'
  );
  assert.equal(valid.reasoning_effort, 'xhigh');
  assert.equal(invalid.reasoning_effort, undefined);
});

test('Codex to Chat maps reasoning for known providers without raw passthrough', () => {
  const { translateResponsesRequestToChat } = require('../out/services/codexResponsesBridge');
  const request = {
    model: 'glm-5.2',
    input: 'hello',
    reasoning: { effort: 'high', summary: 'auto' },
  };
  const glm = translateResponsesRequestToChat(
    request,
    'glm-5.2',
    'https://open.bigmodel.cn/api/coding/paas/v4'
  );
  assert.deepEqual(glm.thinking, { type: 'enabled' });
  assert.equal(glm.reasoning, undefined);
  assert.equal(glm.reasoning_effort, undefined);

  const qwen = translateResponsesRequestToChat(
    request,
    'qwen3-coder-plus',
    'https://dashscope.aliyuncs.com/compatible-mode/v1'
  );
  assert.equal(qwen.enable_thinking, true);

  const openrouter = translateResponsesRequestToChat(
    { ...request, reasoning: { effort: 'max' } },
    'openai/gpt-5',
    'https://openrouter.ai/api/v1'
  );
  assert.deepEqual(openrouter.reasoning, { effort: 'xhigh' });

  const deepseek = translateResponsesRequestToChat(
    { ...request, reasoning: { effort: 'xhigh' } },
    'deepseek-v4-pro',
    'https://api.deepseek.com'
  );
  assert.deepEqual(deepseek.thinking, { type: 'enabled' });
  assert.equal(deepseek.reasoning_effort, 'max');

  const unknown = translateResponsesRequestToChat(
    request,
    'third-party-model',
    'https://example.com/v1'
  );
  assert.equal(unknown.reasoning, undefined);
  assert.equal(unknown.reasoning_effort, undefined);

  const lookalikeHost = translateResponsesRequestToChat(
    request,
    'third-party-model',
    'https://siliconflow.cn.attacker.example/v1'
  );
  assert.equal(lookalikeHost.enable_thinking, undefined);
});

test('thinking budget rectifier uses cc-switch 32000/64000 defaults', () => {
  const {
    applyThinkingBudgetFix,
    classifyRectifierRetry,
    DEFAULT_GATEWAY_RECTIFIER_SETTINGS,
  } = require('../out/services/gatewayRequestRectifier');
  const fixed = applyThinkingBudgetFix({ messages: [], max_tokens: 1024 });
  assert.equal(fixed.thinking.budget_tokens, 32_000);
  assert.equal(fixed.max_tokens, 64_000);
  const adaptive = applyThinkingBudgetFix({
    messages: [],
    thinking: { type: 'adaptive', budget_tokens: 512 },
    max_tokens: 1024,
  });
  assert.equal(adaptive.thinking.type, 'adaptive');
  assert.equal(adaptive.thinking.budget_tokens, 512);
  assert.equal(adaptive.max_tokens, 1024);
  assert.equal(
    classifyRectifierRetry(
      400,
      'thinking.budget_tokens: Input should be greater than or equal to 1024',
      DEFAULT_GATEWAY_RECTIFIER_SETTINGS
    ),
    'thinking_budget'
  );
  assert.equal(
    classifyRectifierRetry(
      400,
      'budget_tokens must be less than max_tokens',
      DEFAULT_GATEWAY_RECTIFIER_SETTINGS
    ),
    null
  );
});

test('Bedrock optimizer injects adaptive thinking and cache breakpoints', () => {
  const {
    applyBedrockRequestOptimizer,
    DEFAULT_GATEWAY_OPTIMIZER_SETTINGS,
  } = require('../out/services/bedrockRequestOptimizer');
  const settings = { ...DEFAULT_GATEWAY_OPTIMIZER_SETTINGS, enabled: true };
  const optimized = applyBedrockRequestOptimizer(
    {
      model: 'anthropic.claude-sonnet-4-6-v1:0',
      max_tokens: 8192,
      tools: [{ name: 'bash' }],
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    },
    settings,
    'https://bedrock-runtime.us-east-1.amazonaws.com'
  );
  assert.equal(optimized.thinking.type, 'adaptive');
  assert.equal(optimized.output_config.effort, 'max');
  assert.ok(optimized.tools[0].cache_control);
  assert.ok(Array.isArray(optimized.system));
  assert.ok(optimized.system[0].cache_control);
});

test('unsupported image rectifier matches text-only self-evident errors', () => {
  const {
    classifyRectifierRetry,
    DEFAULT_GATEWAY_RECTIFIER_SETTINGS,
    containsImageBlocks,
  } = require('../out/services/gatewayRequestRectifier');
  const body = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', data: 'abc' } }],
      },
    ],
  };
  assert.equal(containsImageBlocks(body), true);
  assert.equal(
    classifyRectifierRetry(
      400,
      'Model only support text input',
      DEFAULT_GATEWAY_RECTIFIER_SETTINGS,
      body
    ),
    'unsupported_image'
  );
});

test('buildAnthropicGatewayModelsResponse emits 1M variants when declared', () => {
  const doc = buildAnthropicGatewayModelsResponse({
    sonnetModel: 'glm-5',
    sonnetDisplayName: 'glm-5',
    declareSonnet1m: true,
  });
  const ids = doc.data.map((entry) => entry.id);
  assert.ok(ids.includes('claude-sonnet-4-6'));
  assert.ok(ids.includes('claude-sonnet-4-6[1M]'));
  const oneM = doc.data.find((entry) => entry.id === 'claude-sonnet-4-6[1M]');
  assert.equal(oneM.context_window, 1_048_576);
});

test('shouldDisableCodexWebSearch matches host and model prefix blacklist', () => {
  assert.equal(shouldDisableCodexWebSearch('https://api.xiaomimimo.com/v1', 'mimo-v2'), true);
  assert.equal(shouldDisableCodexWebSearch('https://api.longcat.chat/openai/v1', 'LongCat-2.0'), true);
  assert.equal(shouldDisableCodexWebSearch('https://api.openai.com/v1', 'gpt-5.5'), false);
  assert.equal(shouldDisableCodexWebSearch('https://dashscope.aliyuncs.com/v1', 'qwen3-coder-plus'), true);
  assert.equal(shouldDisableCodexWebSearch('https://dashscope.aliyuncs.com/v1', 'qwen-plus'), false);
});

test('buildCodexModelCatalogDocument uses 1M window when enabled', () => {
  const doc = buildCodexModelCatalogDocument([
    {
      modelId: 'deepseek-v4-pro',
      contextWindow: inferCodexContextWindow('deepseek-v4-pro', true),
      effectiveContextPercent: 100,
    },
  ]);
  assert.equal(doc.models[0].context_window, 1_048_576);
  assert.equal(doc.models[0].effective_context_window_percent, 100);
});

test('buildCodexModelCatalogDocument matches verified Codex catalog shape', () => {
  const doc = buildCodexModelCatalogDocument([
    {
      modelId: 'glm-5.2',
      displayName: 'glm-5.2',
      description: 'GLM-5.2 coding model',
      contextWindow: 1_048_576,
      effectiveContextPercent: 100,
    },
  ]);
  const model = doc.models[0];
  assert.equal(model.slug, 'glm-5.2');
  assert.equal(model.display_name, 'glm-5.2');
  assert.equal(model.description, 'GLM-5.2 coding model');
  assert.equal(model.default_reasoning_level, 'medium');
  assert.equal(model.shell_type, 'shell_command');
  assert.equal(model.visibility, 'list');
  assert.equal(model.supported_in_api, true);
  assert.equal(model.priority, 1);
  assert.equal(model.availability_nux, null);
  assert.equal(model.upgrade, null);
  assert.equal(model.support_verbosity, false);
  assert.equal(model.default_verbosity, null);
  assert.equal(model.default_reasoning_summary, 'auto');
  assert.equal(model.apply_patch_tool_type, 'freeform');
  assert.equal(model.web_search_tool_type, 'text');
  assert.deepEqual(model.truncation_policy, { mode: 'bytes', limit: 10_000 });
  assert.equal(model.supports_parallel_tool_calls, true);
  assert.equal(model.context_window, 1_048_576);
  assert.equal(model.effective_context_window_percent, 100);
  assert.deepEqual(model.experimental_supported_tools, []);
  assert.deepEqual(model.input_modalities, ['text']);
  assert.equal(model.supports_reasoning_summaries, false);
  assert.ok(Array.isArray(model.supported_reasoning_levels));
  assert.ok(model.supported_reasoning_levels.length > 0);
  for (const level of model.supported_reasoning_levels) {
    assert.equal(typeof level.effort, 'string');
    assert.equal(typeof level.description, 'string');
  }
});

test('Codex catalog matches runtime-verified ModelInfo fields', () => {
  const doc = buildCodexModelCatalogDocument([
    {
      modelId: 'third-party-coder',
      contextWindow: 262_144,
    },
  ]);
  const model = doc.models[0];
  assert.equal(model.context_window, 262_144);
  assert.equal(model.apply_patch_tool_type, 'freeform');
  assert.equal(model.web_search_tool_type, 'text');
  assert.equal(model.supports_reasoning_summaries, false);
  assert.equal('max_context_window' in model, false);
  assert.equal('supports_reasoning_summary_parameter' in model, false);
});

test('Codex catalog rejects empty model identifiers', () => {
  assert.throws(
    () =>
      buildCodexModelCatalogDocument([
        {
          modelId: '   ',
          contextWindow: 262_144,
        },
      ]),
    /modelId/
  );
});

test('Codex config writes top-level fields without changing profile fields', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsociety-codex-'));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      '[profiles.work]\nmodel = "profile-model"\nmodel_reasoning_effort = "high"\n',
      'utf8'
    );
    const { applyCodexDirectProvider } = require('../out/services/codexSettings');
    applyCodexDirectProvider({
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-test',
      model: 'third-party-coder',
    });
    const parsed = parseToml(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    assert.equal(parsed.model, 'third-party-coder');
    assert.equal(parsed.model_provider, 'agentsociety-codex');
    assert.equal(parsed.profiles.work.model, 'profile-model');
    assert.equal(parsed.model_providers['agentsociety-codex'].wire_api, 'responses');
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('Codex direct provider preserves versioned coding endpoint paths', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsociety-codex-'));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const { applyCodexDirectProvider } = require('../out/services/codexSettings');
    applyCodexDirectProvider({
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKey: 'sk-test',
      model: 'glm-5.2',
    });
    const parsed = parseToml(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    assert.equal(
      parsed.model_providers['agentsociety-codex'].base_url,
      'https://open.bigmodel.cn/api/coding/paas/v4'
    );
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('Codex gateway applies web-search policy from the real upstream URL', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsociety-codex-'));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const { applyCodexGatewayConfig } = require('../out/services/codexSettings');
    applyCodexGatewayConfig(15721, {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: 'sk-test',
      model: 'vendor-model',
    });
    const parsed = parseToml(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    assert.equal(parsed.web_search, 'disabled');
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('resolveCodexChatModel replaces configured placeholders for known vendors', () => {
  const { resolveCodexChatModel } = require('../out/services/codexModelMapping');
  assert.equal(
    resolveCodexChatModel('gpt-5.5', {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      codexModel: 'gpt-5.5',
      codexApiFormat: 'openai_responses',
    }),
    'mimo-v2.5-pro'
  );
  assert.equal(
    resolveCodexChatModel('gpt-5.5', {
      baseUrl: 'https://api.longcat.chat/openai/v1',
      codexModel: 'gpt-5.5',
      codexApiFormat: 'openai_responses',
    }),
    'LongCat-2.0-Preview'
  );
});

test('Codex config rejects invalid TOML without overwriting the file', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsociety-codex-'));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const configPath = path.join(codexHome, 'config.toml');
  const invalidConfig = '[[invalid\n';
  try {
    fs.writeFileSync(configPath, invalidConfig, 'utf8');
    const { applyCodexDirectProvider } = require('../out/services/codexSettings');
    assert.throws(
      () =>
        applyCodexDirectProvider({
          baseUrl: 'https://example.com/v1',
          apiKey: 'sk-test',
          model: 'third-party-coder',
        }),
      /Invalid Codex config\.toml/
    );
    assert.equal(fs.readFileSync(configPath, 'utf8'), invalidConfig);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('switching to official Codex removes only AgentSociety-owned routing fields', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsociety-codex-'));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      [
        'model = "third-party-coder"',
        'model_provider = "agentsociety-codex"',
        'model_catalog_json = "agentsociety-model-catalog.json"',
        'model_auto_compact_token_limit = 900000',
        'web_search = "disabled"',
        '',
        '[profiles.work]',
        'model = "profile-model"',
        '',
        '[model_providers.agentsociety-codex]',
        'name = "AgentSociety Codex"',
        'base_url = "https://example.com/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = false',
        'experimental_bearer_token = "sk-test"',
        '',
      ].join('\n'),
      'utf8'
    );
    const { applyCodexOfficialSubscription } = require('../out/services/codexSettings');
    applyCodexOfficialSubscription();
    const parsed = parseToml(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    assert.equal(parsed.model, undefined);
    assert.equal(parsed.model_provider, undefined);
    assert.equal(parsed.model_catalog_json, undefined);
    assert.equal(parsed.model_auto_compact_token_limit, undefined);
    assert.equal(parsed.web_search, undefined);
    assert.equal(parsed.profiles.work.model, 'profile-model');
    assert.equal(parsed.model_providers?.['agentsociety-codex'], undefined);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('Codex takeover restore target follows provider hot switches and then returns to official', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsociety-codex-'));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const {
      applyCodexGatewayConfig,
      buildCodexDirectProviderConfigText,
      buildCodexOfficialSubscriptionConfigText,
      restoreCodexLiveBackup,
    } = require('../out/services/codexSettings');

    const official = [
      'model_reasoning_effort = "high"',
      '',
      '[profiles.work]',
      'model = "profile-model"',
      '',
      '[mcp_servers.keep-me]',
      'command = "keep-me"',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), official, 'utf8');

    const directA = buildCodexDirectProviderConfigText(official, {
      baseUrl: 'https://a.example/v1',
      apiKey: 'sk-a',
      model: 'model-a',
    });
    applyCodexGatewayConfig(15721, {
      baseUrl: 'https://a.example/v1',
      apiKey: 'sk-a',
      model: 'model-a',
    });

    const directB = buildCodexDirectProviderConfigText(directA, {
      baseUrl: 'https://b.example/v1',
      apiKey: 'sk-b',
      model: 'model-b',
    });
    assert.equal(restoreCodexLiveBackup(directB), true);
    const restored = parseToml(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    assert.equal(restored.model, 'model-b');
    assert.equal(restored.model_provider, 'agentsociety-codex');
    assert.equal(
      restored.model_providers['agentsociety-codex'].base_url,
      'https://b.example/v1'
    );
    assert.equal(restored.profiles.work.model, 'profile-model');
    assert.equal(restored.mcp_servers['keep-me'].command, 'keep-me');

    const backToOfficial = buildCodexOfficialSubscriptionConfigText(directB);
    const officialAgain = parseToml(backToOfficial);
    assert.equal(officialAgain.model, undefined);
    assert.equal(officialAgain.model_provider, undefined);
    assert.equal(officialAgain.model_providers?.['agentsociety-codex'], undefined);
    assert.equal(officialAgain.model_reasoning_effort, 'high');
    assert.equal(officialAgain.profiles.work.model, 'profile-model');
    assert.equal(officialAgain.mcp_servers['keep-me'].command, 'keep-me');
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('Codex proxy takeover backup refuses placeholder and restores clean live', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsociety-codex-'));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const {
      applyCodexGatewayConfig,
      isCodexGatewayTakeoverConfig,
      releaseCodexGatewayTakeover,
      snapshotCodexLiveBackup,
    } = require('../out/services/codexSettings');

    const clean = [
      'model = "gpt-5.4"',
      '',
      '[profiles.work]',
      'model = "profile-model"',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), clean, 'utf8');
    const backup = snapshotCodexLiveBackup(clean);
    assert.equal(backup, clean);

    applyCodexGatewayConfig(15721, {
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-test',
      model: 'glm-5.2',
    });
    const live = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.equal(isCodexGatewayTakeoverConfig(live), true);
    assert.equal(snapshotCodexLiveBackup(live), null);

    let rebuilt = false;
    const mode = releaseCodexGatewayTakeover(backup, () => {
      rebuilt = true;
    });
    assert.equal(mode, 'backup');
    assert.equal(rebuilt, false);
    const restored = parseToml(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    assert.equal(restored.model, 'gpt-5.4');
    assert.equal(restored.model_provider, undefined);
    assert.equal(restored.profiles.work.model, 'profile-model');

    const mode2 = releaseCodexGatewayTakeover(live, () => {
      rebuilt = true;
      fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "rebuilt"\n', 'utf8');
    });
    assert.equal(mode2, 'rebuild');
    assert.equal(rebuilt, true);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('Codex login status parser recognizes ChatGPT but not API-key login', () => {
  const { isCodexChatGptLoginStatusOutput } = require('../out/services/codexSettings');
  assert.equal(isCodexChatGptLoginStatusOutput('Logged in using ChatGPT'), true);
  assert.equal(isCodexChatGptLoginStatusOutput('Logged in using an API key'), false);
  assert.equal(isCodexChatGptLoginStatusOutput('Not logged in'), false);
});

test('Codex provider without a model removes stale AgentSociety model metadata', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsociety-codex-'));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      [
        'model = "stale-model"',
        'model_provider = "agentsociety-codex"',
        'model_catalog_json = "agentsociety-model-catalog.json"',
        'model_auto_compact_token_limit = 900000',
        '',
        '[profiles.work]',
        'model = "profile-model"',
        '',
      ].join('\n'),
      'utf8'
    );
    const { applyCodexDirectProvider } = require('../out/services/codexSettings');
    applyCodexDirectProvider({
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-test',
      model: '',
    });
    const parsed = parseToml(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    assert.equal(parsed.model, undefined);
    assert.equal(parsed.model_catalog_json, undefined);
    assert.equal(parsed.model_auto_compact_token_limit, undefined);
    assert.equal(parsed.profiles.work.model, 'profile-model');
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('applying Codex provider always rewrites model catalog', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsociety-codex-'));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    fs.writeFileSync(
      path.join(codexHome, 'agentsociety-model-catalog.json'),
      JSON.stringify({
        models: [
          {
            slug: 'glm-5.2',
            supports_reasoning_summary_parameter: false,
            max_context_window: 1048576,
            default_reasoning_summary: 'none',
            supports_parallel_tool_calls: false,
          },
        ],
      }),
      'utf8'
    );
    const { applyCodexDirectProvider } = require('../out/services/codexSettings');
    applyCodexDirectProvider({
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-test',
      model: 'glm-5.2',
      codexEnable1m: true,
    });
    const rewritten = JSON.parse(
      fs.readFileSync(path.join(codexHome, 'agentsociety-model-catalog.json'), 'utf8')
    );
    const model = rewritten.models[0];
    assert.ok(Array.isArray(model.supported_reasoning_levels));
    assert.equal(model.apply_patch_tool_type, 'freeform');
    assert.equal(model.default_reasoning_summary, 'auto');
    assert.equal(model.supports_parallel_tool_calls, true);
    assert.equal('max_context_window' in model, false);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('Codex direct provider leaves official auth.json untouched', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsociety-codex-'));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const authPath = path.join(codexHome, 'auth.json');
    const oauth = {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { access_token: 'oauth-token', refresh_token: 'refresh-token' },
      last_refresh: '2026-07-13T00:00:00Z',
    };
    fs.writeFileSync(authPath, JSON.stringify(oauth), 'utf8');
    const { applyCodexDirectProvider, hasCodexOfficialLogin } = require('../out/services/codexSettings');
    applyCodexDirectProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-third-party',
      model: 'gpt-5.5',
    });
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    assert.deepEqual(auth, oauth);
    assert.equal(hasCodexOfficialLogin(), true);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('isCodexResponsesPath accepts compact endpoints like cc-switch', () => {
  const { isCodexResponsesPath } = require('../out/services/codexApiFormat');
  assert.equal(isCodexResponsesPath('/v1/responses'), true);
  assert.equal(isCodexResponsesPath('/v1/responses/compact'), true);
  assert.equal(isCodexResponsesPath('/responses/compact?stream=true'), true);
  assert.equal(isCodexResponsesPath('/v1/chat/completions'), false);
});

test('CODEX_MODEL_CATALOG_FILENAME is a relative basename', () => {
  const { CODEX_MODEL_CATALOG_FILENAME } = require('../out/services/codexModelCatalog');
  assert.equal(CODEX_MODEL_CATALOG_FILENAME, 'agentsociety-model-catalog.json');
  assert.equal(CODEX_MODEL_CATALOG_FILENAME.includes('/') || CODEX_MODEL_CATALOG_FILENAME.includes('\\'), false);
});

test('extractTokenUsage reads nested response.completed usage', () => {
  const { extractTokenUsage } = require('../out/services/gatewayUsageTracker');
  const parsed = extractTokenUsage({
    type: 'response.completed',
    response: {
      model: 'gpt-5.5',
      usage: { input_tokens: 120, output_tokens: 45 },
    },
  });
  assert.equal(parsed?.inputTokens, 120);
  assert.equal(parsed?.outputTokens, 45);
  assert.equal(parsed?.model, 'gpt-5.5');
});

test('parseClaudeSessionUsageLine reads usage and keeps message id for dedupe', () => {
  const { parseClaudeSessionUsageLine } = require('../out/services/claudeSessionUsage');
  const parsed = parseClaudeSessionUsageLine(JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-12T04:08:30.302Z',
    message: {
      id: 'msg_123',
      role: 'assistant',
      model: 'glm-4.7',
      usage: {
        input_tokens: 24,
        output_tokens: 242,
        cache_read_input_tokens: 24896,
        cache_creation_input_tokens: 12,
      },
    },
  }), 'Fiblab');
  assert.equal(parsed?.requestId, 'msg_123');
  assert.equal(parsed?.source, 'session');
  assert.equal(parsed?.provider, 'Fiblab');
  assert.equal(parsed?.inputTokens, 24);
  assert.equal(parsed?.outputTokens, 242);
  assert.equal(parsed?.cacheReadTokens, 24896);
  assert.equal(parsed?.cacheCreationTokens, 12);
});

test('web import config retains key and fills Claude role models', () => {
  const {
    buildGatewayProviderFromWebImport,
    resolveWebImportClaudeConfig,
  } = require('../out/services/webConfigGatewayImport');
  const claude = resolveWebImportClaudeConfig({
    openaiCompatible: ['glm-4.7', 'deepseek-v4-flash'],
    claudeCode: [],
    embedding: [],
  }, {
    simulation: 'glm-4.7',
    claudeCodeHaiku: 'deepseek-v4-flash',
    claudeCodeFable: 'claude-fable-5',
  });
  const provider = buildGatewayProviderFromWebImport(
    ' sk-fiblab ',
    ' https://llmapi.fiblab.net/v1 ',
    claude,
    { enableCodex1m: true }
  );
  assert.equal(provider?.name, 'Fiblab');
  assert.equal(provider?.apiKey, 'sk-fiblab');
  assert.equal(provider?.baseUrl, 'https://llmapi.fiblab.net/v1');
  assert.equal(provider?.model, 'glm-4.7');
  assert.equal(provider?.sonnetModel, 'glm-4.7');
  assert.equal(provider?.opusModel, 'glm-4.7');
  assert.equal(provider?.fableModel, 'claude-fable-5');
  assert.equal(provider?.haikuModel, 'deepseek-v4-flash');
  assert.equal(provider?.apiKind, 'openai');
  assert.equal(provider?.codexEnable1m, true);
});

test('web import leaves Fable empty when it is not returned', () => {
  const { resolveWebImportClaudeConfig } = require('../out/services/webConfigGatewayImport');
  const claude = resolveWebImportClaudeConfig({
    openaiCompatible: ['glm-4.7'],
    claudeCode: [],
    embedding: [],
  }, {
    simulation: 'glm-4.7',
  });
  assert.equal(claude.fableModel, '');
});

test('Claude settings read the Fable environment field', () => {
  const { extractClaudeConfig } = require('../out/services/claudeCodeSettings');
  const config = extractClaudeConfig({
    env: {
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5',
    },
  });
  assert.equal(config.fableModel, 'claude-fable-5');
});

test('Claude model discovery recognizes Fable', () => {
  const { suggestClaudeModelMappings } = require('../out/services/claudeCodeModels');
  const mappings = suggestClaudeModelMappings([
    { id: 'claude-sonnet-4-6' },
    { id: 'claude-fable-5' },
  ]);
  assert.equal(mappings.fableModel, 'claude-fable-5');
});

test('Claude gateway catalog omits unavailable Fable', () => {
  const { buildAnthropicGatewayModelsResponse } = require('../out/services/anthropicGatewayModels');
  const catalog = buildAnthropicGatewayModelsResponse({
    opusModel: 'claude-opus-4-8',
  });
  assert.equal(catalog.data.some((model) => /fable/i.test(model.id)), false);
});

test('selectAccountingUsageRecords deduplicates proxy and session sources', () => {
  const { selectAccountingUsageRecords } = require('../out/services/gatewayUsageTracker');
  const base = {
    app: 'claude',
    model: 'glm-4.7',
    inputTokens: 24,
    outputTokens: 242,
    cacheReadTokens: 24896,
    cacheCreationTokens: 0,
    serverToolUseTokens: 0,
    status: 200,
  };
  const proxy = {
    ...base,
    source: 'proxy',
    requestId: '',
    upstream: 'https://llmapi.fiblab.net/v1',
    ts: '2026-07-12T04:08:28.000Z',
  };
  const session = {
    ...base,
    source: 'session',
    requestId: 'msg_123',
    upstream: 'claude-session',
    ts: '2026-07-12T04:08:30.302Z',
  };
  assert.deepEqual(selectAccountingUsageRecords([proxy, session]), [proxy]);

  const emptyProxy = {
    ...proxy,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
  };
  assert.deepEqual(selectAccountingUsageRecords([emptyProxy, session]), [session]);
});

test('shouldRecordGatewayRequest counts completion posts but not models list', () => {
  const {
    normalizeGatewayRequestPath,
    shouldRecordGatewayRequest,
  } = require('../out/services/aiCliGateway');
  assert.equal(shouldRecordGatewayRequest('GET', '/v1/models?client_version=0.142.5'), false);
  assert.equal(shouldRecordGatewayRequest('POST', '/v1/responses'), true);
  assert.equal(shouldRecordGatewayRequest('GET', '/health'), false);
  assert.equal(normalizeGatewayRequestPath('/api/anthropic/v1/messages'), '/v1/messages');
  assert.equal(
    normalizeGatewayRequestPath('/api/anthropic/v1/models?client_version=2.1.207'),
    '/v1/models?client_version=2.1.207'
  );
});

test('upstreamHealth reports degraded and unhealthy states', () => {
  assert.equal(upstreamHealth(undefined), 'healthy');
  assert.equal(upstreamHealth({ consecutiveFailures: 1, openUntil: 0 }), 'degraded');
  assert.equal(upstreamHealth({ consecutiveFailures: 3, openUntil: Date.now() + 60_000 }), 'unhealthy');
});


test('text-only model registry matches cc-switch exact tails and fail-open', () => {
  const { isLikelyTextOnlyModel } = require('../out/services/gatewayRequestRectifier');
  assert.equal(isLikelyTextOnlyModel('deepseek/deepseek-v4-pro'), true);
  assert.equal(isLikelyTextOnlyModel('GLM-5.2[1M]'), true);
  assert.equal(isLikelyTextOnlyModel('LongCat-2.0'), true);
  assert.equal(isLikelyTextOnlyModel('MiniMax-M2.7-Highspeed'), true);
  assert.equal(isLikelyTextOnlyModel('glm-5.2v'), false);
  assert.equal(isLikelyTextOnlyModel('MiniMax-M3'), false);
  assert.equal(isLikelyTextOnlyModel('minimax-m2.7-vision'), false);
  assert.equal(isLikelyTextOnlyModel('gpt-5.5'), false);
});

test('codex route default-on probe requires no explicit choice, no user setup, eligible provider', () => {
  const { shouldEnableCodexRouteByDefault } = require('../out/services/codexSettings');
  const base = {
    explicitlySet: false,
    userConfigured: false,
    officialLoginPresent: false,
    hasEligibleProvider: true,
  };
  assert.equal(shouldEnableCodexRouteByDefault(base), true);

  // Any explicit choice (user toggle, prior default, or an older build's write) wins.
  assert.equal(shouldEnableCodexRouteByDefault({ ...base, explicitlySet: true }), false);
  // User-authored config.toml provider blocks are never overridden.
  assert.equal(shouldEnableCodexRouteByDefault({ ...base, userConfigured: true }), false);
  // Official OAuth login and API-key-only auth.json are both user-owned setups.
  assert.equal(shouldEnableCodexRouteByDefault({ ...base, officialLoginPresent: true }), false);
  // Without a routable provider there is nothing to default on.
  assert.equal(shouldEnableCodexRouteByDefault({ ...base, hasEligibleProvider: false }), false);
});
