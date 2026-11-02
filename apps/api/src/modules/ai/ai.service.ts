import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";

import { schema } from "@lms-core/db";
import { ROLE_CODES } from "@lms-core/shared";

import { AuditService } from "../audit/audit.service";
import { RequestUser } from "../auth/current-user.decorator";
import { DatabaseService } from "../database/database.service";
import { AskAiDto } from "./dto/ask-ai.dto";

type AiSourceItem = {
  entityType: "document" | "course" | "test";
  entityId: string;
  title: string;
  snippet: string;
  score: number;
};

type AiAskResponse = {
  answer: string;
  matched: boolean;
  sources: AiSourceItem[];
  rule: string;
};

type SearchCandidate = {
  entityType: "document" | "course" | "test";
  entityId: string;
  title: string;
  body: string;
};

@Injectable()
export class AiService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async askForActor(payload: AskAiDto, actor: RequestUser): Promise<AiAskResponse> {
    try {
      const effectiveClientId = this.resolveClientId(payload, actor);
      const candidates = await this.loadCandidates(effectiveClientId);
      const ranked = this.rankCandidates(payload.question, candidates);
      const topMatches = ranked.slice(0, 3);
      const matched = topMatches.length > 0;

      const answer = matched
        ? this.buildGroundedAnswer(payload.question, topMatches)
        : "Я не нашел подтвержденный ответ в материалах клиента. Нужна загрузка новых материалов или ручная проверка админом.";

      await this.auditService.writeLog({
        clientId: effectiveClientId,
        actorUserId: actor.userId,
        action: "ai.ask",
        entityType: "ai",
        entityId: effectiveClientId,
        details: {
          questionLength: payload.question.length,
          matched,
          sources: topMatches.map((item) => ({
            entityType: item.entityType,
            entityId: item.entityId,
            score: item.score
          }))
        }
      });

      return {
        answer,
        matched,
        sources: topMatches,
        rule: "answer-only-from-client-knowledge-base"
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to process AI question", {
        cause: error
      });
    }
  }

  getMeta(): { module: string; status: string; askRoute: string; rule: string } {
    return {
      module: "ai",
      status: "active",
      askRoute: "/api/ai/ask",
      rule: "answer-only-from-client-knowledge-base"
    };
  }

  private resolveClientId(payload: AskAiDto, actor: RequestUser): string {
    if (actor.roleCode === ROLE_CODES.employee) {
      return actor.clientId;
    }

    if (actor.roleCode === ROLE_CODES.clientAdmin) {
      if (payload.clientId && payload.clientId !== actor.clientId) {
        throw new ForbiddenException("Client admin cannot ask AI for another client");
      }

      return actor.clientId;
    }

    if (!payload.clientId) {
      throw new ForbiddenException("System admin must provide clientId");
    }

    return payload.clientId;
  }

  private async loadCandidates(clientId: string): Promise<SearchCandidate[]> {
    const [documents, courses, tests] = await Promise.all([
      this.databaseService.db
        .select()
        .from(schema.documents)
        .where(
          and(eq(schema.documents.clientId, clientId), eq(schema.documents.isPublished, true))
        ),
      this.databaseService.db
        .select()
        .from(schema.courses)
        .where(
          and(eq(schema.courses.clientId, clientId), eq(schema.courses.isPublished, true))
        ),
      this.databaseService.db
        .select()
        .from(schema.tests)
        .where(and(eq(schema.tests.clientId, clientId), eq(schema.tests.isPublished, true)))
    ]);

    return [
      ...documents.map((item) => ({
        entityType: "document" as const,
        entityId: item.id,
        title: item.title,
        body: `${item.title} ${item.description ?? ""}`.trim()
      })),
      ...courses.map((item) => ({
        entityType: "course" as const,
        entityId: item.id,
        title: item.title,
        body: `${item.title} ${item.description ?? ""} ${item.roleLabel ?? ""}`.trim()
      })),
      ...tests.map((item) => ({
        entityType: "test" as const,
        entityId: item.id,
        title: item.title,
        body: `${item.title} ${item.description ?? ""}`.trim()
      }))
    ];
  }

  private rankCandidates(question: string, candidates: SearchCandidate[]): AiSourceItem[] {
    const tokens = this.tokenize(question);

    if (tokens.length === 0) {
      return [];
    }

    return candidates
      .map((candidate) => {
        const haystack = candidate.body.toLowerCase();
        let score = 0;

        for (const token of tokens) {
          if (haystack.includes(token)) {
            score += token.length > 6 ? 3 : 2;
          }
        }

        if (score === 0) {
          return null;
        }

        return {
          entityType: candidate.entityType,
          entityId: candidate.entityId,
          title: candidate.title,
          snippet: this.buildSnippet(candidate.body, tokens),
          score
        };
      })
      .filter((item): item is AiSourceItem => item !== null)
      .sort((left, right) => right.score - left.score);
  }

  private buildGroundedAnswer(question: string, matches: AiSourceItem[]): string {
    const sourceText = matches
      .map((item) => `${item.entityType}: ${item.title}. Фрагмент: ${item.snippet}`)
      .join(" ");

    return `По вопросу "${question}" я нашел материалы клиента. ${sourceText}`;
  }

  private buildSnippet(body: string, tokens: string[]): string {
    const cleanBody = body.replace(/\s+/g, " ").trim();
    const lowerBody = cleanBody.toLowerCase();
    const foundIndex = tokens
      .map((token) => lowerBody.indexOf(token))
      .find((index) => index >= 0);

    if (foundIndex === undefined) {
      return cleanBody.slice(0, 180);
    }

    const start = Math.max(0, foundIndex - 40);
    const end = Math.min(cleanBody.length, foundIndex + 140);

    return cleanBody.slice(start, end);
  }

  private tokenize(input: string): string[] {
    return Array.from(
      new Set(
        input
          .toLowerCase()
          .split(/[^a-zA-Zа-яА-Я0-9]+/)
          .map((token) => token.trim())
          .filter((token) => token.length >= 3)
      )
    );
  }
}
