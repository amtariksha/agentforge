export interface TenantConfig {
  persona: {
    name: string;
    avatar: { name: string; emoji: string; imageUrl?: string };
    personalityTraits: string[];
    tone: 'formal' | 'casual' | 'balanced';
    definition: string;
    guidelines: string;
    introduction: string;
    languagePrimary: string;
    languageSupported: string[];
    responseStyle: {
      maxLength: 'short' | 'medium' | 'long';
      useEmojis: boolean;
      useMarkdown: boolean;
      formattingRules: string;
    };
    fallbackMessage: string;
    systemPromptAdditions: string;
  };

  channels: {
    whatsapp?: {
      phoneNumberId: string;
      wabaId: string;
      accessToken: string;
      webhookVerifyToken: string;
      appSecret: string;
      coexistenceEnabled: boolean;
      operatorPauseMinutes: number;
    };
    telegram?: { botToken: string; webhookUrl: string };
    web?: {
      widgetConfig: {
        position: 'bottom-right' | 'bottom-left';
        primaryColor: string;
        greetingMessage: string;
        logoUrl?: string;
        enableFeedback: boolean;
        enableStreaming: boolean;
      };
    };
  };

  backend: {
    baseUrl: string;
    authType: 'api_key' | 'oauth2' | 'jwt' | 'basic';
    authCredentials: Record<string, string>;
    userLookupEndpoint: string;
    rateLimit: { requestsPerMinute: number; requestsPerHour: number };
  };

  ecommerce?: {
    platform: 'woocommerce' | 'shopify' | 'custom';
    storeUrl: string;
    apiKey: string;
    apiSecret: string;
    razorpayKeyId?: string;
    razorpayKeySecret?: string;
    enableCart: boolean;
    enableCheckout: boolean;
  };

  ai: {
    primaryModel: string;
    premiumModel: string;
    routingModel: string;
    maxTokensPerResponse: number;
    temperature: number;
    monthlyTokenBudget: number;
    enableThinking: boolean;
    promptCacheEnabled: boolean;
    fallbackProvider?: string;
  };

  context: {
    systemTokenBudget: number;
    shortTermBudget: number;
    longTermBudget: number;
    memoryIndexBudget: number;
    summarizationThreshold: number;
    maxConversationTurns: number;
  };

  hitl: {
    autoEscalateConfidenceBelow: number;
    autoEscalateTopics: string[];
    requireApprovalForActions: string[];
    maxAutoActionsPerSession: number;
    escalationChannels: ('dashboard' | 'whatsapp' | 'email')[];
  };

  orchestrator: {
    enableAutoRouting: boolean;
    confidenceThreshold: number;
    maxAgentSwitchesPerSession: number;
    handoffOnLowConfidence: boolean;
    handoffOnNegativeSentiment: boolean;
    handoffOnUserRequest: boolean;
    handoffKeywords: string[];
  };

  agents: AgentTypeConfig[];
}

export interface AgentTypeConfig {
  id?: string;
  name: string;
  slug: string;
  avatarEmoji: string;
  description: string;
  systemPrompt: string;
  intentKeywords: string[];
  intentExamples: string[];
  priority: number;
  confidenceThreshold: number;
  isDefault: boolean;
  modelOverride?: string | null;
  availableTools?: string[];
  activeHours?: { start: string; end: string; timezone: string } | null;
  /** Phase-1 LMS integration — see src/shared/schema/agents.ts. */
  shadowMode?: boolean;
  dailySpendCapUsd?: number | string | null;
}
