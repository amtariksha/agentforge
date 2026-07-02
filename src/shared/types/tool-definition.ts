export interface ToolDefinition {
  id?: string;
  tenantId?: string;
  name: string;
  description: string;
  category: 'read' | 'write' | 'destructive';
  requiresHitl: boolean;
  requiresUserConfirm: boolean;

  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
    }>;
    required: string[];
  };

  backendMapping: BackendMapping;

  execution: {
    timeoutMs: number;
    retryCount: number;
    fallbackMessage: string;
  };

  permissions: {
    agentTypes: string[];
    requiresUserAuth: boolean;
  };

  isActive: boolean;
}

export interface BackendMapping {
  type: 'external' | 'internal';

  // For external (PATH A)
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  endpoint?: string;
  headers?: Record<string, string>;
  bodyTemplate?: Record<string, unknown>;
  responseMapping?: {
    successField: string;
    dataField: string;
    errorField: string;
  };

  // For internal (PATH B)
  handler?: string; // "swarg-food.getUserProfile"
}

export interface ToolExecutionResult {
  success: boolean;
  data: unknown;
  error?: {
    code: string;
    message: string;
  };
  /**
   * Generative-UI blocks (Milestone 2, emission path A). Raw ContentBlock[];
   * validated + whitelisted in executor.ts, never trusted as-is. Typed `unknown`
   * here so this pure type module stays free of a runtime import.
   */
  ui?: unknown;
  durationMs: number;
}
