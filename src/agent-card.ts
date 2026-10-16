import { AgentCard } from "@a2a-js/sdk";

import type { Config } from "./config.ts";
import { REPLY_EXTENSION_URI } from "./reply.ts";

/**
 * The Agent Card: who the agent is from the config, JSON-RPC over HTTP, a ServiceAccount token as bearer, and the
 * reply extension (ADR 0015), which callers may activate.
 */
export function buildAgentCard(config: Config): AgentCard {
  return {
    name: config.name,
    description: config.description,
    version: config.version,
    supportedInterfaces: [{ url: config.publicUrl, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" }],
    provider: undefined,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [
        {
          uri: REPLY_EXTENSION_URI,
          description:
            "Activate it to get the reply of a completed task also as a data part: a summary of up to three lines, sections of Markdown, and sources.",
          required: false,
          params: undefined,
        },
      ],
    },
    securitySchemes: {
      bearer: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: {
            scheme: "Bearer",
            bearerFormat: "JWT",
            description: "A Kubernetes ServiceAccount token issued for the a2a audience.",
          },
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    // Files of any type, as parts with the bytes (ADR 0023).
    defaultInputModes: ["text/plain", "*/*"],
    defaultOutputModes: ["text/plain"],
    skills: config.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      examples: skill.examples,
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    })),
    signatures: [],
  };
}

/**
 * The card as served at `/.well-known/agent-card.json`. The SDK's own agentCardHandler writes the in-memory form
 * (with `$case` unions), so the card is converted here. Scopes in `securityRequirements` are written as a plain
 * list: a2a-go, and so the official `a2a-cli`, reads them that way and rejects ProtoJSON's `{"list": [...]}`,
 * and the JS SDK accepts it (the list here is empty).
 */
export function agentCardJson(config: Config): Record<string, unknown> {
  const card = buildAgentCard(config);
  return {
    ...(AgentCard.toJSON(card) as Record<string, unknown>),
    securityRequirements: card.securityRequirements.map((requirement) => ({
      schemes: Object.fromEntries(Object.entries(requirement.schemes).map(([name, scopes]) => [name, scopes.list])),
    })),
  };
}
