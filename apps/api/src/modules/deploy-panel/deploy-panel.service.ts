import { randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";

import { schema } from "@lms-core/db";
import {
  ClientPreviewSettings,
  DEFAULT_INDUSTRY_TEMPLATE,
  DEFAULT_CLIENT_PREVIEW_SETTINGS,
  DeployStatus,
  DEPLOY_STATUSES,
  getIndustryTemplateLabel,
  getIndustryTemplateShortLabel,
  getDeployStatusLabel,
  getTariffFeatures,
  isDeployStatus,
  mergeClientPreviewSettings,
  resolveLocalPreviewOrigin,
  ROLE_CODES,
  TariffFeatures
} from "@lms-core/shared";

import { DatabaseService } from "../database/database.service";
import { BootstrapClientDto } from "./dto/bootstrap-client.dto";
import { DeployWorkflowActionDto } from "./dto/deploy-workflow-action.dto";
import { DeployClientDetailDto } from "./dto/deploy-client-detail.dto";
import { PreviewSettingsQueryDto, SavePreviewSettingsDto } from "./dto/preview-settings.dto";
import { UpdateDeployProfileDto } from "./dto/update-deploy-profile.dto";
import { ValidateClientDto } from "./dto/validate-client.dto";

const deployProfiles = (schema as Record<string, unknown>).deployProfiles as any;
const clientPreviewSettings = (schema as Record<string, unknown>).clientPreviewSettings as any;
const workspaceRoot = path.resolve(__dirname, "../../../../..");
const DEFAULT_LMS_SOURCE_PATH = process.env.CORE_DESKTOP_MODE === "1" ? "" : path.join(workspaceRoot, "apps/lms-web");
const DEFAULT_PREVIEW_HOST = resolveLocalPreviewOrigin(process.env.CORE_LMS_PREVIEW_ORIGIN);
const GENERATED_DEPLOYMENTS_ROOT = path.join(workspaceRoot, "infra/generated/deployments");

type DeployChecklistItem = {
  code: string;
  label: string;
  status: "ready" | "pending";
  note: string;
};

type DeployValidationItem = {
  code: string;
  label: string;
  status: "passed" | "failed";
  note: string;
};

type DeployActivityItem = {
  id: string;
  action: string;
  title: string;
  note: string;
  createdAt: string;
};

type DeployRunStep = {
  code: string;
  label: string;
  note: string;
};

type DeployRunSummary = {
  hasRun: boolean;
  lastRunAt: string | null;
  status: string | null;
  stepCount: number;
  steps: DeployRunStep[];
};

type DeployHealthItem = {
  code: string;
  label: string;
  status: "healthy" | "degraded" | "down" | "unknown";
  note: string;
};

type DeployHealthSummary = {
  overallStatus: "healthy" | "degraded" | "down";
  healthyCount: number;
  degradedCount: number;
  downCount: number;
  unknownCount: number;
  items: DeployHealthItem[];
};

type DeployHealthHistoryItem = {
  id: string;
  overallStatus: "healthy" | "degraded" | "down";
  createdAt: string;
  note: string;
};

type DeployThemePalette = {
  primary: string;
  accent: string;
  background: string;
  surface: string;
};

type DeployClientCard = {
  id: string;
  name: string;
  slug: string;
  domain: string;
  brandName: string;
  tariff: string;
  industryTemplate: string;
  aiRequestsLimit: number | null;
  isActive: boolean;
  firstAdminEmail: string | null;
  readinessPercent: number;
  readyCount: number;
  pendingCount: number;
  deployStatus: string | null;
  deployStatusLabel: string;
  features: TariffFeatures;
};

type DeployClientDetail = {
  client: DeployClientCard;
  adminCredentials: {
    clientAdminLogin: string | null;
    clientAdminPhone: string | null;
    clientAdminFirstName: string | null;
    clientAdminLastName: string | null;
    systemAdminLogin: string | null;
  };
  checklist: DeployChecklistItem[];
  profile: any | null;
  validation: {
    isValid: boolean;
    passedCount: number;
    failedCount: number;
    items: DeployValidationItem[];
  };
  activity: DeployActivityItem[];
  deployRun: DeployRunSummary;
  health: DeployHealthSummary;
  healthHistory: DeployHealthHistoryItem[];
};

@Injectable()
export class DeployPanelService {
  constructor(private readonly databaseService: DatabaseService) {}

  async getDashboard(): Promise<{
    summary: {
      totalClients: number;
      activeClients: number;
      draftCount: number;
      validatedCount: number;
      readyToDeployCount: number;
      deployedCount: number;
    };
    clients: DeployClientCard[];
  }> {
    try {
      const clients = await this.databaseService.db
        .select()
        .from(schema.clients)
        .orderBy(desc(schema.clients.createdAt));

      const clientAdminRoleId = await this.getClientAdminRoleId();
      const [adminUsers, profiles] = await Promise.all([
        clientAdminRoleId
          ? this.databaseService.db
              .select()
              .from(schema.users)
              .where(eq(schema.users.roleId, clientAdminRoleId))
          : Promise.resolve([]),
        this.databaseService.db.select().from(deployProfiles)
      ]);

      const cards = clients.map((client) =>
        this.toDeployClientCard(
          client,
          adminUsers.find((item) => item.clientId === client.id) ?? null,
          profiles.find((item) => item.clientId === client.id) ?? null
        )
      );

      return {
        summary: {
          totalClients: cards.length,
          activeClients: cards.filter((item) => item.isActive).length,
          draftCount: cards.filter((item) => item.deployStatus === DEPLOY_STATUSES.draft).length,
          validatedCount: cards.filter((item) => item.deployStatus === DEPLOY_STATUSES.validated).length,
          readyToDeployCount: cards.filter((item) => item.deployStatus === DEPLOY_STATUSES.readyToDeploy).length,
          deployedCount: cards.filter((item) => item.deployStatus === DEPLOY_STATUSES.deployed).length
        },
        clients: cards
      };
    } catch (error) {
      throw new InternalServerErrorException("Failed to load deploy panel dashboard", {
        cause: error
      });
    }
  }

  async getClientDetail(query: DeployClientDetailDto): Promise<DeployClientDetail> {
    try {
      const [client] = await this.databaseService.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, query.clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      const clientAdminRoleId = await this.getClientAdminRoleId();
      const systemAdminRoleId = await this.getSystemAdminRoleId();
      const [[adminUser] = [], [systemAdminUser] = [], [profile] = [], auditItems, deployAuditItems] = await Promise.all([
        clientAdminRoleId
          ? this.databaseService.db
              .select()
              .from(schema.users)
              .where(
                and(
                  eq(schema.users.roleId, clientAdminRoleId),
                  eq(schema.users.clientId, client.id)
                )
              )
          : Promise.resolve([]),
        systemAdminRoleId
          ? this.databaseService.db
              .select()
              .from(schema.users)
              .where(
                and(
                  eq(schema.users.roleId, systemAdminRoleId),
                  eq(schema.users.clientId, client.id)
                )
              )
          : Promise.resolve([]),
        this.databaseService.db
          .select()
          .from(deployProfiles)
          .where(eq(deployProfiles.clientId, client.id))
          .limit(1),
        this.databaseService.db
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.clientId, client.id))
          .orderBy(desc(schema.auditLog.createdAt))
          .limit(20),
        this.databaseService.db
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.clientId, client.id))
          .orderBy(desc(schema.auditLog.createdAt))
          .limit(80)
      ]);

      const card = this.toDeployClientCard(
        client,
        adminUser && adminUser.clientId === client.id ? adminUser : null,
        profile ?? null
      );

      return {
        client: card,
        adminCredentials: {
          clientAdminLogin: adminUser?.email ?? null,
          clientAdminPhone: adminUser?.phone ?? null,
          clientAdminFirstName: adminUser?.firstName ?? null,
          clientAdminLastName: adminUser?.lastName ?? null,
          systemAdminLogin: systemAdminUser?.email ?? null
        },
        checklist: this.buildChecklist(client, card.firstAdminEmail, profile ?? null),
        profile: profile ?? null,
        validation: this.buildValidation(client, card.firstAdminEmail, profile ?? null),
        activity: this.buildActivity(auditItems),
        deployRun: this.buildDeployRunSummary(deployAuditItems),
        health: await this.buildHealthSummary(profile ?? null),
        healthHistory: this.buildHealthHistory(deployAuditItems)
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load deploy panel client detail", {
        cause: error
      });
    }
  }

  getMeta(): { module: string; status: string; dashboardRoute: string; detailRoute: string } {
    return {
      module: "deploy-panel",
      status: "active",
      dashboardRoute: "/api/deploy-panel/dashboard",
      detailRoute: "/api/deploy-panel/client-detail"
    };
  }

  async getPreviewSettings(query: PreviewSettingsQueryDto): Promise<{
    clientId: string;
    settings: ClientPreviewSettings;
    source: "saved" | "default";
  }> {
    try {
      const client = await this.ensureClientExists(query.clientId);

      const [settingsRow] = await this.databaseService.db
        .select()
        .from(clientPreviewSettings)
        .where(eq(clientPreviewSettings.clientId, query.clientId))
        .limit(1);

      return {
        clientId: query.clientId,
        settings: settingsRow
          ? this.toClientPreviewSettings(settingsRow)
          : this.buildDefaultPreviewSettingsForClient(client, null),
        source: settingsRow ? "saved" : "default"
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load preview settings", {
        cause: error
      });
    }
  }

  async savePreviewSettings(payload: SavePreviewSettingsDto): Promise<{
    clientId: string;
    settings: ClientPreviewSettings;
    source: "saved";
  }> {
    try {
      const client = await this.ensureClientExists(payload.clientId);

      const [existingSettingsRow] = await this.databaseService.db
        .select()
        .from(clientPreviewSettings)
        .where(eq(clientPreviewSettings.clientId, payload.clientId))
        .limit(1);

      const existingSettings = existingSettingsRow
        ? this.toClientPreviewSettings(existingSettingsRow)
        : this.buildDefaultPreviewSettingsForClient(client, null);
      const nextSettings = this.mergePreviewSettingsPayload(existingSettings, payload);

      const [savedSettingsRow] = existingSettingsRow
        ? await this.databaseService.db
            .update(clientPreviewSettings)
            .set({
              theme: nextSettings.theme,
              typography: nextSettings.typography,
              content: nextSettings.content,
              layout: nextSettings.layout,
              components: nextSettings.components,
              elementOverrides: nextSettings.elementOverrides,
              updatedByUserId: null,
              updatedAt: new Date()
            })
            .where(eq(clientPreviewSettings.clientId, payload.clientId))
            .returning()
        : await this.databaseService.db
            .insert(clientPreviewSettings)
            .values({
              clientId: payload.clientId,
              theme: nextSettings.theme,
              typography: nextSettings.typography,
              content: nextSettings.content,
              layout: nextSettings.layout,
              components: nextSettings.components,
              elementOverrides: nextSettings.elementOverrides,
              updatedByUserId: null
            })
            .returning();

      await this.databaseService.db.insert(schema.auditLog).values({
        clientId: payload.clientId,
        actorUserId: null,
        action: "preview_settings.saved",
        entityType: "client_preview_settings",
        entityId: savedSettingsRow.id,
        details: {
          source: "deploy_panel_preview_constructor",
          sections: Object.keys(payload).filter((key) => key !== "clientId")
        }
      });

      return {
        clientId: payload.clientId,
        settings: this.toClientPreviewSettings(savedSettingsRow),
        source: "saved"
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to save preview settings", {
        cause: error
      });
    }
  }

  async saveBrandingImage(clientId: string, bytes: Buffer): Promise<unknown> {
    try {
      await this.ensureClientExists(clientId);
      const root = path.resolve(__dirname, "../../../../..");
      const images = require(path.join(root, "infra/scripts/client-brand-assets.cjs")) as { storeImage: (root: string, id: string, bytes: Buffer) => Promise<{ sha256: string; bytes: number; mime: string }> };
      const image = await images.storeImage(root, clientId, bytes);
      await this.databaseService.db.insert(schema.auditLog).values({ clientId, actorUserId: null, action: "preview_asset.uploaded", entityType: "client_brand_asset", entityId: clientId, details: { sha256: image.sha256, bytes: image.bytes, mime: image.mime } });
      return image;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException("Изображение не сохранено. Проверьте формат, размер и доступ к каталогу Core.");
    }
  }

  async readBrandingImage(clientId: string, asset: string): Promise<{ bytes: Buffer; info: { mime: string } }> {
    const root = path.resolve(__dirname, "../../../../..");
    const images = require(path.join(root, "infra/scripts/client-brand-assets.cjs")) as { readImage: (root: string, id: string, file: string) => Promise<{ bytes: Buffer; info: { mime: string } }> };
    return images.readImage(root, clientId, asset);
  }

  async bootstrapClient(payload: BootstrapClientDto): Promise<{
    clientId: string;
    adminEmail: string;
    systemAdminLogin: string;
    deployProfileId: string;
  }> {
    try {
      const clientAdminRoleId = await this.getClientAdminRoleId();
      const systemAdminRoleId = await this.getSystemAdminRoleId();

      if (!clientAdminRoleId || !systemAdminRoleId) {
        throw new NotFoundException("Required roles not found. Run role seed first.");
      }

      const tariffDefaults = getTariffFeatures(payload.tariff);

      const existingClient = await this.databaseService.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.slug, payload.slug))
        .limit(1);

      if (existingClient.length > 0) {
        throw new BadRequestException("Client with this slug already exists");
      }

      const result = await this.databaseService.db.transaction(async (tx) => {
        const [client] = await tx
          .insert(schema.clients)
          .values({
            name: payload.name,
            slug: payload.slug,
            domain: payload.domain,
            brandName: payload.brandName,
            primaryColor: payload.primaryColor,
            tariff: payload.tariff,
            industryTemplate: payload.industryTemplate ?? DEFAULT_INDUSTRY_TEMPLATE,
            isActive: payload.isActive ?? true,
            includedUsers: payload.includedUsers ?? tariffDefaults.includedUsers,
            maxAdmins: payload.maxAdmins ?? tariffDefaults.maxAdmins,
            aiRequestsLimit: payload.aiRequestsLimit
          })
          .returning();

        const [adminUser] = await tx
          .insert(schema.users)
          .values({
            clientId: client.id,
            roleId: clientAdminRoleId,
            email: payload.adminLogin ?? payload.adminEmail,
            phone: payload.adminPhone,
            firstName: payload.adminFirstName,
            lastName: payload.adminLastName,
            passwordHash: this.hashPassword(payload.adminPassword)
          })
          .returning();

        const [systemAdminUser] = await tx
          .insert(schema.users)
          .values({
            clientId: client.id,
            roleId: systemAdminRoleId,
            email: payload.systemAdminLogin,
            phone: null,
            firstName: "System",
            lastName: "Admin",
            passwordHash: this.hashPassword(payload.systemAdminPassword)
          })
          .returning();

        const [profile] = await tx
          .insert(deployProfiles)
          .values({
            clientId: client.id,
            hostUrl: payload.hostUrl,
            deployPath: payload.deployPath,
            lmsSourcePath: payload.lmsSourcePath ?? DEFAULT_LMS_SOURCE_PATH,
            databaseHost: payload.databaseHost,
            databasePort: payload.databasePort,
            databaseName: payload.databaseName,
            databaseUser: payload.databaseUser,
            databasePasswordSecretRef: payload.databasePasswordSecretRef,
            storageBucket: payload.storageBucket,
            storageRegion: payload.storageRegion,
            storageEndpoint: payload.storageEndpoint,
            storageSecretRef: payload.storageSecretRef,
            aiProvider: payload.aiProvider,
            aiModel: payload.aiModel,
            aiSecretRef: payload.aiSecretRef,
            aliceTenantCode: payload.aliceTenantCode ?? payload.slug,
            aliceModelPreset: payload.aliceModelPreset ?? "alice-default",
            previewThemePrimary: payload.previewThemePrimary ?? payload.primaryColor,
            previewThemeAccent: payload.previewThemeAccent ?? "#6ee7d8",
            previewThemeBackground: payload.previewThemeBackground ?? "#071419",
            previewThemeSurface: payload.previewThemeSurface ?? "#0f2229",
            status: DEPLOY_STATUSES.draft
          })
          .returning();

        await tx.insert(clientPreviewSettings).values({
          clientId: client.id,
          theme: {
            ...DEFAULT_CLIENT_PREVIEW_SETTINGS.theme,
            primary: payload.previewThemePrimary ?? payload.primaryColor,
            accent: payload.previewThemeAccent ?? DEFAULT_CLIENT_PREVIEW_SETTINGS.theme.accent,
            background:
              payload.previewThemeBackground ?? DEFAULT_CLIENT_PREVIEW_SETTINGS.theme.background,
            surface: payload.previewThemeSurface ?? DEFAULT_CLIENT_PREVIEW_SETTINGS.theme.surface,
            button: payload.previewThemePrimary ?? payload.primaryColor
          },
          typography: DEFAULT_CLIENT_PREVIEW_SETTINGS.typography,
          content: {
            ...DEFAULT_CLIENT_PREVIEW_SETTINGS.content,
            homeTitle: client.brandName
          },
          layout: DEFAULT_CLIENT_PREVIEW_SETTINGS.layout,
          components: DEFAULT_CLIENT_PREVIEW_SETTINGS.components,
          elementOverrides: DEFAULT_CLIENT_PREVIEW_SETTINGS.elementOverrides,
          updatedByUserId: null
        });

        await tx.insert(schema.auditLog).values([
          {
            clientId: client.id,
            actorUserId: null,
            action: "client.created",
            entityType: "client",
            entityId: client.id,
            details: {
              name: client.name,
              tariff: client.tariff,
              industryTemplate: client.industryTemplate,
              source: "deploy_panel_bootstrap"
            }
          },
          {
            clientId: client.id,
            actorUserId: adminUser.id,
            action: "user.created",
            entityType: "user",
            entityId: adminUser.id,
            details: {
              email: adminUser.email,
              source: "deploy_panel_bootstrap"
            }
          },
          {
            clientId: client.id,
            actorUserId: systemAdminUser.id,
            action: "user.created",
            entityType: "user",
            entityId: systemAdminUser.id,
            details: {
              email: systemAdminUser.email,
              source: "deploy_panel_bootstrap",
              role: ROLE_CODES.systemAdmin
            }
          },
          {
            clientId: client.id,
            actorUserId: adminUser.id,
            action: "deploy_profile.created",
            entityType: "deploy_profile",
            entityId: profile.id,
            details: {
              hostUrl: profile.hostUrl,
              lmsSourcePath: profile.lmsSourcePath,
              databaseHost: profile.databaseHost,
              storageBucket: profile.storageBucket,
              aiProvider: profile.aiProvider
            }
          }
        ]);

        return {
          clientId: client.id,
          adminEmail: adminUser.email,
          systemAdminLogin: systemAdminUser.email,
          deployProfileId: profile.id
        };
      });

      return result;
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to bootstrap client from deploy panel", {
        cause: error
      });
    }
  }

  async updateDeployProfile(payload: UpdateDeployProfileDto): Promise<{
    clientId: string;
    deployProfileId: string;
    status: string;
  }> {
    try {
      const [client] = await this.databaseService.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, payload.clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      const [existingProfile] = await this.databaseService.db
        .select()
        .from(deployProfiles)
        .where(eq(deployProfiles.clientId, payload.clientId))
        .limit(1);

      if (!existingProfile) {
        throw new NotFoundException("Deploy profile not found");
      }

      const clientAdminRoleId = await this.getClientAdminRoleId();
      const systemAdminRoleId = await this.getSystemAdminRoleId();

      const [clientAdminUser] = clientAdminRoleId
        ? await this.databaseService.db
            .select()
            .from(schema.users)
            .where(
              and(
                eq(schema.users.roleId, clientAdminRoleId),
                eq(schema.users.clientId, payload.clientId)
              )
            )
            .limit(1)
        : [];

      const [systemAdminUser] = systemAdminRoleId
        ? await this.databaseService.db
            .select()
            .from(schema.users)
            .where(
              and(
                eq(schema.users.roleId, systemAdminRoleId),
                eq(schema.users.clientId, payload.clientId)
              )
            )
            .limit(1)
        : [];

      if (clientAdminRoleId && !clientAdminUser && (payload.clientAdminLogin || payload.clientAdminName) && !payload.clientAdminPassword) throw new BadRequestException("Для создания отсутствующего администратора задайте пароль явно.");
      if (systemAdminRoleId && !systemAdminUser && payload.systemAdminLogin && !payload.systemAdminPassword) throw new BadRequestException("Для создания отсутствующего системного администратора задайте пароль явно.");

      const nextTariff = payload.tariff ?? client.tariff;
      const nextIndustryTemplate = payload.industryTemplate ?? client.industryTemplate;
      const tariffDefaults = getTariffFeatures(nextTariff);

      await this.databaseService.db
        .update(schema.clients)
        .set({
          brandName: payload.brandName ?? client.brandName,
          primaryColor: payload.primaryColor ?? client.primaryColor,
          tariff: nextTariff,
          industryTemplate: nextIndustryTemplate,
          includedUsers: payload.includedUsers ?? client.includedUsers ?? tariffDefaults.includedUsers,
          maxAdmins: payload.maxAdmins ?? client.maxAdmins ?? tariffDefaults.maxAdmins,
          aiRequestsLimit:
            typeof payload.aiRequestsLimit === "number"
              ? payload.aiRequestsLimit
              : client.aiRequestsLimit,
          updatedAt: new Date()
        })
        .where(eq(schema.clients.id, payload.clientId));

      if (clientAdminRoleId && (payload.clientAdminLogin || payload.clientAdminPassword || payload.clientAdminName)) {
        if (clientAdminUser) {
          await this.databaseService.db
            .update(schema.users)
            .set({
              email: payload.clientAdminLogin ?? clientAdminUser.email,
              firstName: payload.clientAdminName ?? clientAdminUser.firstName,
              passwordHash: payload.clientAdminPassword
                ? this.hashPassword(payload.clientAdminPassword)
                : clientAdminUser.passwordHash,
              updatedAt: new Date()
            })
            .where(eq(schema.users.id, clientAdminUser.id));
        } else {
          await this.databaseService.db.insert(schema.users).values({
            clientId: payload.clientId,
            roleId: clientAdminRoleId,
            email: payload.clientAdminLogin ?? `${client.slug}-admin@local`,
            phone: null,
            firstName: payload.clientAdminName ?? "Client",
            lastName: "Admin",
            passwordHash: this.hashPassword(payload.clientAdminPassword!),
            isActive: true
          });
        }
      }

      if (systemAdminRoleId && (payload.systemAdminLogin || payload.systemAdminPassword)) {
        if (systemAdminUser) {
          await this.databaseService.db
            .update(schema.users)
            .set({
              email: payload.systemAdminLogin ?? systemAdminUser.email,
              passwordHash: payload.systemAdminPassword
                ? this.hashPassword(payload.systemAdminPassword)
                : systemAdminUser.passwordHash,
              updatedAt: new Date()
            })
            .where(eq(schema.users.id, systemAdminUser.id));
        } else {
          await this.databaseService.db.insert(schema.users).values({
            clientId: payload.clientId,
            roleId: systemAdminRoleId,
            email: payload.systemAdminLogin ?? `${client.slug}-system@local`,
            phone: null,
            firstName: "System",
            lastName: "Admin",
            passwordHash: this.hashPassword(payload.systemAdminPassword!),
            isActive: true
          });
        }
      }

      const draftProfile = {
        ...existingProfile,
        hostUrl: payload.hostUrl,
        deployPath: payload.deployPath,
        lmsSourcePath: payload.lmsSourcePath ?? existingProfile.lmsSourcePath,
        databaseHost: payload.databaseHost,
        databasePort: payload.databasePort,
        databaseName: payload.databaseName,
        databaseUser: payload.databaseUser,
        databasePasswordSecretRef: payload.databasePasswordSecretRef,
        storageBucket: payload.storageBucket,
        storageRegion: payload.storageRegion,
        storageEndpoint: payload.storageEndpoint,
        storageSecretRef: payload.storageSecretRef,
        aiProvider: payload.aiProvider,
        aiModel: payload.aiModel,
        aiSecretRef: payload.aiSecretRef,
        aliceTenantCode: payload.aliceTenantCode ?? existingProfile.aliceTenantCode,
        aliceModelPreset: payload.aliceModelPreset ?? existingProfile.aliceModelPreset,
        previewThemePrimary:
          payload.previewThemePrimary ??
          payload.primaryColor ??
          existingProfile.previewThemePrimary,
        previewThemeAccent: payload.previewThemeAccent ?? existingProfile.previewThemeAccent,
        previewThemeBackground:
          payload.previewThemeBackground ?? existingProfile.previewThemeBackground,
        previewThemeSurface: payload.previewThemeSurface ?? existingProfile.previewThemeSurface,
        status: existingProfile.status
      };

      const [profile] = await this.databaseService.db
        .update(deployProfiles)
        .set({
          hostUrl: payload.hostUrl,
          deployPath: payload.deployPath,
          lmsSourcePath: payload.lmsSourcePath ?? existingProfile.lmsSourcePath,
          databaseHost: payload.databaseHost,
          databasePort: payload.databasePort,
          databaseName: payload.databaseName,
          databaseUser: payload.databaseUser,
          databasePasswordSecretRef: payload.databasePasswordSecretRef,
          storageBucket: payload.storageBucket,
          storageRegion: payload.storageRegion,
          storageEndpoint: payload.storageEndpoint,
          storageSecretRef: payload.storageSecretRef,
          aiProvider: payload.aiProvider,
          aiModel: payload.aiModel,
          aiSecretRef: payload.aiSecretRef,
          aliceTenantCode: payload.aliceTenantCode ?? existingProfile.aliceTenantCode,
          aliceModelPreset: payload.aliceModelPreset ?? existingProfile.aliceModelPreset,
          previewThemePrimary:
            payload.previewThemePrimary ??
            payload.primaryColor ??
            existingProfile.previewThemePrimary,
          previewThemeAccent: payload.previewThemeAccent ?? existingProfile.previewThemeAccent,
          previewThemeBackground:
            payload.previewThemeBackground ?? existingProfile.previewThemeBackground,
          previewThemeSurface: payload.previewThemeSurface ?? existingProfile.previewThemeSurface,
          status: existingProfile.status,
          updatedAt: new Date()
        })
        .where(eq(deployProfiles.clientId, payload.clientId))
        .returning();

      await this.databaseService.db.insert(schema.auditLog).values({
        clientId: payload.clientId,
        actorUserId: null,
        action: "deploy_profile.updated",
        entityType: "deploy_profile",
        entityId: profile.id,
        details: {
          status: profile.status,
          tariff: nextTariff,
          industryTemplate: nextIndustryTemplate,
          brandName: payload.brandName ?? client.brandName,
          hostUrl: profile.hostUrl,
          lmsSourcePath: profile.lmsSourcePath,
          databaseHost: profile.databaseHost,
          storageBucket: profile.storageBucket,
          aiProvider: profile.aiProvider
        }
      });

      return {
        clientId: payload.clientId,
        deployProfileId: profile.id,
        status: profile.status
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to update deploy profile", {
        cause: error
      });
    }
  }

  async markDraft(payload: DeployWorkflowActionDto): Promise<{
    clientId: string;
    deployProfileId: string;
    status: string;
  }> {
    return this.updateWorkflowStatus(payload.clientId, DEPLOY_STATUSES.draft);
  }

  async markValidated(payload: DeployWorkflowActionDto): Promise<{
    clientId: string;
    deployProfileId: string;
    status: string;
  }> {
    return this.updateWorkflowStatus(payload.clientId, DEPLOY_STATUSES.validated);
  }

  async markReadyToDeploy(payload: DeployWorkflowActionDto): Promise<{
    clientId: string;
    deployProfileId: string;
    status: string;
  }> {
    return this.updateWorkflowStatus(payload.clientId, DEPLOY_STATUSES.readyToDeploy);
  }

  async markDeployed(payload: DeployWorkflowActionDto): Promise<{
    clientId: string;
    deployProfileId: string;
    status: string;
  }> {
    return this.updateWorkflowStatus(payload.clientId, DEPLOY_STATUSES.deployed);
  }

  async runDeploy(payload: DeployWorkflowActionDto): Promise<{
    clientId: string;
    deployProfileId: string;
    status: string;
    deploymentBundlePath: string;
    steps: DeployRunStep[];
  }> {
    try {
      const [client] = await this.databaseService.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, payload.clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      const [existingProfile] = await this.databaseService.db
        .select()
        .from(deployProfiles)
        .where(eq(deployProfiles.clientId, payload.clientId))
        .limit(1);

      if (!existingProfile) {
        throw new NotFoundException("Deploy profile not found");
      }

      const clientAdminRoleId = await this.getClientAdminRoleId();
      const [adminUser] = clientAdminRoleId
        ? await this.databaseService.db
            .select()
            .from(schema.users)
            .where(
              and(
                eq(schema.users.roleId, clientAdminRoleId),
                eq(schema.users.clientId, client.id)
              )
            )
            .limit(1)
        : [];

      const validation = this.buildValidation(client, adminUser?.email ?? null, existingProfile);
      if (existingProfile.status !== DEPLOY_STATUSES.readyToDeploy) {
        throw new BadRequestException(
          "Локальный пакет можно подготовить только после перевода клиента в статус 'Готово к деплою'."
        );
      }

      if (!validation.isValid) {
        throw new BadRequestException(
          "Нельзя подготовить локальный пакет: технический профиль клиента не прошел проверку."
        );
      }

      const deploymentBundlePath = await this.createDeploymentBundle(client, existingProfile);
      const steps = this.buildDeployRunSteps(deploymentBundlePath);

      const result = await this.databaseService.db.transaction(async (tx) => {
        await tx.insert(schema.auditLog).values({
          clientId: payload.clientId,
          actorUserId: null,
          action: "deploy_bundle.started",
          entityType: "deploy_profile",
          entityId: existingProfile.id,
          details: {
            status: existingProfile.status,
            stepCount: steps.length
          }
        });

        for (const step of steps) {
          await tx.insert(schema.auditLog).values({
            clientId: payload.clientId,
            actorUserId: null,
            action: "deploy_bundle.step",
            entityType: "deploy_profile",
            entityId: existingProfile.id,
            details: {
              code: step.code,
              label: step.label,
              note: step.note
            }
          });
        }

        const [profile] = await tx
          .update(deployProfiles)
          .set({
            deploymentBundlePath,
            status: DEPLOY_STATUSES.readyToDeploy,
            updatedAt: new Date()
          })
          .where(eq(deployProfiles.clientId, payload.clientId))
          .returning();

        await tx.insert(schema.auditLog).values({
          clientId: payload.clientId,
          actorUserId: null,
          action: "deploy_bundle.created",
          entityType: "deploy_profile",
          entityId: profile.id,
          details: {
            status: profile.status,
            stepCount: steps.length,
            note: "Пакет создан локально; удаленный сервер не изменялся",
            deploymentBundlePath
          }
        });

        return {
          clientId: payload.clientId,
          deployProfileId: profile.id,
          status: profile.status,
          deploymentBundlePath,
          steps
        };
      });

      return result;
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to run deploy scenario", {
        cause: error
      });
    }
  }

  async runHealthCheck(payload: DeployWorkflowActionDto): Promise<{
    clientId: string;
    overallStatus: "healthy" | "degraded" | "down";
    healthyCount: number;
    degradedCount: number;
    downCount: number;
    unknownCount: number;
    items: DeployHealthItem[];
  }> {
    try {
      const [client] = await this.databaseService.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, payload.clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      const [profile] = await this.databaseService.db
        .select()
        .from(deployProfiles)
        .where(eq(deployProfiles.clientId, payload.clientId))
        .limit(1);

      if (!profile) {
        throw new NotFoundException("Deploy profile not found");
      }

      const health = await this.buildHealthSummary(profile);

      await this.databaseService.db.insert(schema.auditLog).values({
        clientId: payload.clientId,
        actorUserId: null,
        action: "health_check.completed",
        entityType: "deploy_profile",
        entityId: profile.id,
        details: {
          overallStatus: health.overallStatus,
          healthyCount: health.healthyCount,
          degradedCount: health.degradedCount,
          downCount: health.downCount,
          unknownCount: health.unknownCount,
          items: health.items
        }
      });

      return {
        clientId: payload.clientId,
        overallStatus: health.overallStatus,
        healthyCount: health.healthyCount,
        degradedCount: health.degradedCount,
        downCount: health.downCount,
        unknownCount: health.unknownCount,
        items: health.items
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to run health-check", {
        cause: error
      });
    }
  }

  async validateClient(query: ValidateClientDto): Promise<{
    clientId: string;
    isValid: boolean;
    recommendedStatus: string;
    passedCount: number;
    failedCount: number;
    items: DeployValidationItem[];
  }> {
    try {
      const [client] = await this.databaseService.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, query.clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      const clientAdminRoleId = await this.getClientAdminRoleId();
      const [[adminUser] = [], [profile] = []] = await Promise.all([
        clientAdminRoleId
          ? this.databaseService.db
              .select()
              .from(schema.users)
              .where(
                and(
                  eq(schema.users.roleId, clientAdminRoleId),
                  eq(schema.users.clientId, client.id)
                )
              )
          : Promise.resolve([]),
        this.databaseService.db
          .select()
          .from(deployProfiles)
          .where(eq(deployProfiles.clientId, client.id))
          .limit(1)
      ]);

      const validation = this.buildValidation(client, adminUser?.email ?? null, profile ?? null);

      return {
        clientId: client.id,
        isValid: validation.isValid,
        recommendedStatus: validation.isValid
          ? DEPLOY_STATUSES.validated
          : profile?.status ?? DEPLOY_STATUSES.draft,
        passedCount: validation.passedCount,
        failedCount: validation.failedCount,
        items: validation.items
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to validate deploy client", {
        cause: error
      });
    }
  }

  private async getClientAdminRoleId(): Promise<string | null> {
    const [role] = await this.databaseService.db
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.code, ROLE_CODES.clientAdmin))
      .limit(1);

    return role?.id ?? null;
  }

  private async getSystemAdminRoleId(): Promise<string | null> {
    const [role] = await this.databaseService.db
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.code, ROLE_CODES.systemAdmin))
      .limit(1);

    return role?.id ?? null;
  }

  private toDeployClientCard(
    client: typeof schema.clients.$inferSelect,
    adminUser: typeof schema.users.$inferSelect | null,
    profile: any | null
  ): DeployClientCard {
    const features = getTariffFeatures(client.tariff);
    const checklist = this.buildChecklist(client, adminUser?.email ?? null, profile);
    const readyCount = checklist.filter((item) => item.status === "ready").length;
    const pendingCount = checklist.filter((item) => item.status === "pending").length;
    const readinessPercent = Math.round((readyCount / checklist.length) * 100);

    return {
      id: client.id,
      name: client.name,
      slug: client.slug,
      domain: client.domain,
      brandName: client.brandName,
      tariff: client.tariff,
      industryTemplate: client.industryTemplate,
      aiRequestsLimit: client.aiRequestsLimit,
      isActive: client.isActive,
      firstAdminEmail: adminUser?.email ?? null,
      readinessPercent,
      readyCount,
      pendingCount,
      deployStatus: profile?.status ?? null,
      deployStatusLabel: profile?.status ? getDeployStatusLabel(profile.status) : "Нет статуса",
      features
    };
  }

  private buildChecklist(
    client: typeof schema.clients.$inferSelect,
    firstAdminEmail: string | null,
    profile: any | null
  ): DeployChecklistItem[] {
    return [
      {
        code: "brand",
        label: "Бренд",
        status: client.brandName ? "ready" : "pending",
        note: client.brandName ? client.brandName : "Название бренда пока не заполнено"
      },
      {
        code: "domain",
        label: "Домен",
        status: client.domain ? "ready" : "pending",
        note: client.domain ? client.domain : "Домен пока не заполнен"
      },
      {
        code: "industry_template",
        label: "Отраслевой шаблон",
        status: client.industryTemplate ? "ready" : "pending",
        note: client.industryTemplate
          ? getIndustryTemplateLabel(client.industryTemplate)
          : "Отраслевой шаблон пока не выбран"
      },
      {
        code: "tariff",
        label: "Тариф",
        status: client.tariff ? "ready" : "pending",
        note: client.tariff ? `Тариф: ${client.tariff}` : "Тариф пока не выбран"
      },
      {
        code: "first_admin",
        label: "Первый админ",
        status: firstAdminEmail ? "ready" : "pending",
        note: firstAdminEmail ? firstAdminEmail : "Первый админ клиента пока не создан"
      },
      {
        code: "limits",
        label: "Лимиты",
        status: client.includedUsers > 0 && client.maxAdmins > 0 ? "ready" : "pending",
        note: `Пользователи: ${client.includedUsers}, админы: ${client.maxAdmins}`
      },
      {
        code: "deploy_status",
        label: "Статус деплоя",
        status: profile?.status ? "ready" : "pending",
        note: profile?.status ? getDeployStatusLabel(profile.status) : "Статус еще не задан"
      },
      {
        code: "host",
        label: "Хост",
        status: profile?.hostUrl ? "ready" : "pending",
        note: profile?.hostUrl ? profile.hostUrl : "Адрес хоста пока не сохранен в API"
      },
      {
        code: "lms_source",
        label: "Исходник LMS",
        status: this.hasLmsSourcePath(profile) ? "ready" : "pending",
        note: this.hasLmsSourcePath(profile)
          ? profile.lmsSourcePath
          : "Путь к исходнику LMS пока не задан или папка не найдена"
      },
      {
        code: "database",
        label: "База данных",
        status: profile?.databaseHost && profile?.databaseName && profile?.databaseUser ? "ready" : "pending",
        note:
          profile?.databaseHost && profile?.databaseName
            ? `${profile.databaseHost}:${profile.databasePort}/${profile.databaseName}`
            : "Параметры отдельной базы данных пока не сохранены"
      },
      {
        code: "storage",
        label: "Storage",
        status: profile?.storageBucket ? "ready" : "pending",
        note: profile?.storageBucket ? profile.storageBucket : "Параметры приватного storage пока не сохранены"
      },
      {
        code: "ai",
        label: "AI настройки",
        status: profile?.aiProvider && profile?.aiModel ? "ready" : "pending",
        note:
          profile?.aiProvider && profile?.aiModel
            ? `${profile.aiProvider} / ${profile.aiModel}`
            : "Параметры AI пока не сохранены"
      },
      {
        code: "theme",
        label: "Тема LMS",
        status: this.hasThemePalette(client, profile) ? "ready" : "pending",
        note: this.getThemeSummary(client, profile)
      },
      {
        code: "alice_model",
        label: "Alice AI tenant",
        status:
          this.hasSecretRef(profile?.aliceTenantCode) && this.hasSecretRef(profile?.aliceModelPreset)
            ? "ready"
            : "pending",
        note:
          this.hasSecretRef(profile?.aliceTenantCode) && this.hasSecretRef(profile?.aliceModelPreset)
            ? `${profile.aliceTenantCode} / ${profile.aliceModelPreset}`
            : "Нужно указать tenant code и preset для Alice AI"
      }
    ];
  }

  private buildValidation(
    client: typeof schema.clients.$inferSelect,
    firstAdminEmail: string | null,
    profile: any | null
  ): {
    isValid: boolean;
    passedCount: number;
    failedCount: number;
    items: DeployValidationItem[];
  } {
    const items: DeployValidationItem[] = [
      {
        code: "client_identity",
        label: "Карточка клиента",
        status:
          client.name && client.slug && client.domain && client.industryTemplate
            ? "passed"
            : "failed",
        note:
          client.name && client.slug && client.domain && client.industryTemplate
            ? `Клиент ${client.name} имеет slug ${client.slug}, домен ${client.domain} и шаблон ${getIndustryTemplateShortLabel(client.industryTemplate)}`
            : "Не хватает базовых данных клиента: name, slug, domain или отраслевой шаблон"
      },
      {
        code: "admin_account",
        label: "Первый админ",
        status: firstAdminEmail ? "passed" : "failed",
        note: firstAdminEmail ? `Первый админ найден: ${firstAdminEmail}` : "Первый админ еще не создан"
      },
      {
        code: "host_url",
        label: "Хост LMS",
        status: this.isValidUrl(profile?.hostUrl) ? "passed" : "failed",
        note: this.isValidUrl(profile?.hostUrl) ? profile.hostUrl : "Host URL должен быть полным адресом, например https://client.example.com"
      },
      {
        code: "deploy_path",
        label: "Путь деплоя",
        status: this.isValidDeployPath(profile?.deployPath) ? "passed" : "failed",
        note:
          this.isValidDeployPath(profile?.deployPath)
            ? profile.deployPath
            : "Путь деплоя должен начинаться с / и быть сохранен в deploy profile"
      },
      {
        code: "lms_source",
        label: "Исходник LMS",
        status: this.hasLmsSourcePath(profile) ? "passed" : "failed",
        note: this.hasLmsSourcePath(profile)
          ? profile.lmsSourcePath
          : "Нужен реальный путь к внутренней папке LMS: apps/lms-web"
      },
      {
        code: "database_mapping",
        label: "Контур базы данных",
        status: this.hasDatabaseProfile(profile) ? "passed" : "failed",
        note:
          this.hasDatabaseProfile(profile)
            ? `${profile.databaseHost}:${profile.databasePort}/${profile.databaseName}`
            : "Не заполнены host, port, databaseName или databaseUser для PostgreSQL"
      },
      {
        code: "database_secret",
        label: "Секрет базы данных",
        status: this.hasSecretRef(profile?.databasePasswordSecretRef) ? "passed" : "failed",
        note:
          this.hasSecretRef(profile?.databasePasswordSecretRef)
            ? profile.databasePasswordSecretRef
            : "Нужна ссылка на секрет пароля базы данных"
      },
      {
        code: "storage_profile",
        label: "Storage",
        status: this.hasStorageProfile(profile) ? "passed" : "failed",
        note:
          this.hasStorageProfile(profile)
            ? `${profile.storageBucket}${profile.storageRegion ? ` / ${profile.storageRegion}` : ""}`
            : "Нужно заполнить bucket и секрет storage"
      },
      {
        code: "ai_profile",
        label: "AI контур",
        status: this.hasAiProfile(profile) ? "passed" : "failed",
        note:
          this.hasAiProfile(profile)
            ? `${profile.aiProvider} / ${profile.aiModel}`
            : "Нужно заполнить AI provider, model и ссылку на AI секрет"
      },
      {
        code: "alice_model",
        label: "Alice AI модель клиента",
        status:
          this.hasSecretRef(profile?.aliceTenantCode) && this.hasSecretRef(profile?.aliceModelPreset)
            ? "passed"
            : "failed",
        note:
          this.hasSecretRef(profile?.aliceTenantCode) && this.hasSecretRef(profile?.aliceModelPreset)
            ? `${profile.aliceTenantCode} / ${profile.aliceModelPreset}`
            : "Нужно указать tenant code и preset для Alice AI"
      },
      {
        code: "preview_theme",
        label: "Тема и preview LMS",
        status: this.hasThemePalette(client, profile) ? "passed" : "failed",
        note: this.getThemeSummary(client, profile)
      }
    ];

    const passedCount = items.filter((item) => item.status === "passed").length;
    const failedCount = items.length - passedCount;

    return {
      isValid: failedCount === 0,
      passedCount,
      failedCount,
      items
    };
  }

  private buildActivity(
    auditItems: Array<typeof schema.auditLog.$inferSelect>
  ): DeployActivityItem[] {
    return auditItems
      .filter((item) =>
        [
          "client.created",
          "user.created",
          "deploy_profile.created",
          "deploy_profile.updated",
          "deploy_workflow.marked",
          "deploy_run.started",
          "deploy_run.step",
          "deploy_run.completed",
          "deploy_bundle.started",
          "deploy_bundle.step",
          "deploy_bundle.created",
          "health_check.completed"
        ].includes(item.action)
      )
      .map((item) => ({
        id: item.id,
        action: item.action,
        title: this.getActivityTitle(item.action),
        note: this.getActivityNote(item),
        createdAt: item.createdAt.toISOString()
      }));
  }

  private buildDeployRunSummary(
    auditItems: Array<typeof schema.auditLog.$inferSelect>
  ): DeployRunSummary {
    const completedRun = auditItems.find((item) =>
      ["deploy_run.completed", "deploy_bundle.created"].includes(item.action)
    );

    if (!completedRun) {
      return {
        hasRun: false,
        lastRunAt: null,
        status: null,
        stepCount: 0,
        steps: []
      };
    }

    const completedDetails = (completedRun.details ?? {}) as Record<string, unknown>;
    const stepOrder = [
      "validate_profile",
      "copy_seed_data",
      "write_configuration",
      "write_bundle"
    ];

    const stepItems = auditItems
      .filter(
        (item) =>
          ["deploy_run.step", "deploy_bundle.step"].includes(item.action) &&
          item.createdAt.getTime() === completedRun.createdAt.getTime()
      )
      .map((item) => {
        const details = (item.details ?? {}) as Record<string, unknown>;

        return {
          code: typeof details.code === "string" ? details.code : "unknown_step",
          label: typeof details.label === "string" ? details.label : "Шаг deploy-run",
          note: typeof details.note === "string" ? details.note : "Детали шага не сохранены"
        };
      })
      .sort((left, right) => stepOrder.indexOf(left.code) - stepOrder.indexOf(right.code));

    return {
      hasRun: true,
      lastRunAt: completedRun.createdAt.toISOString(),
      status: typeof completedDetails.status === "string" ? completedDetails.status : null,
      stepCount:
        typeof completedDetails.stepCount === "number"
          ? completedDetails.stepCount
          : stepItems.length,
      steps: stepItems
    };
  }

  private async buildHealthSummary(
    profile: any | null
  ): Promise<DeployHealthSummary> {
    const apiHealth = await this.checkApiHealth();
    const databaseHealth = await this.checkDatabaseHealth();
    const tenantDatabaseHealth = this.checkTenantDatabaseHealth(profile);
    const storageHealth = this.checkStorageHealth(profile);
    const aiHealth = this.checkAiHealth(profile);

    const items: DeployHealthItem[] = [
      apiHealth,
      databaseHealth,
      tenantDatabaseHealth,
      storageHealth,
      aiHealth
    ];
    const healthyCount = items.filter((item) => item.status === "healthy").length;
    const degradedCount = items.filter((item) => item.status === "degraded").length;
    const downCount = items.filter((item) => item.status === "down").length;
    const unknownCount = items.filter((item) => item.status === "unknown").length;

    return {
      overallStatus:
        downCount > 0
          ? "down"
          : degradedCount > 0 || unknownCount > 0
            ? "degraded"
            : "healthy",
      healthyCount,
      degradedCount,
      downCount,
      unknownCount,
      items
    };
  }

  private async checkApiHealth(): Promise<DeployHealthItem> {
    try {
      const response = await fetch("http://127.0.0.1:3001/api/health");
      if (!response.ok) {
        return {
          code: "api",
          label: "Core API (локально)",
          status: "down",
          note: `Локальный API ответил кодом ${response.status}`
        };
      }

      return {
        code: "api",
        label: "Core API (локально)",
        status: "healthy",
        note: "Локальный API Core ответил успешно; API клиентского сайта отдельно не проверялся"
      };
    } catch {
      return {
        code: "api",
        label: "Core API (локально)",
        status: "down",
        note: "Локальный Core API сейчас недоступен"
      };
    }
  }

  private async checkDatabaseHealth(): Promise<DeployHealthItem> {
    try {
      await this.databaseService.db.execute("select 1");

      return {
        code: "core_database",
        label: "PostgreSQL Core (локально)",
        status: "healthy",
        note: "Локальная база Core ответила на запрос; база клиента отдельно не проверялась"
      };
    } catch {
      return {
          code: "core_database",
          label: "PostgreSQL Core (локально)",
        status: "down",
        note: "Главная PostgreSQL база сейчас недоступна"
      };
    }
  }

  private checkTenantDatabaseHealth(profile: any | null): DeployHealthItem {
    const hasProfile = this.hasDatabaseProfile(profile);

    return {
      code: "client_database",
      label: "База данных клиента",
      status: "unknown",
      note: hasProfile
        ? `Параметры указаны (${profile.databaseHost}:${profile.databasePort}/${profile.databaseName}), но соединение с сервером клиента еще не проверяется`
        : "Подключение к отдельной базе клиента еще не настроено и не проверялось"
    };
  }

  private checkStorageHealth(profile: any | null): DeployHealthItem {
    if (
      profile?.storageBucket &&
      this.hasSecretRef(profile?.storageSecretRef) &&
      this.isValidUrl(profile?.storageEndpoint)
    ) {
      return {
        code: "storage",
        label: "Storage",
        status: "unknown",
        note: `Настройки заполнены (${profile.storageBucket}), но подключение к хранилищу еще не проверяется`
      };
    }

    if (profile?.storageBucket || profile?.storageEndpoint || profile?.storageSecretRef) {
      return {
        code: "storage",
        label: "Storage",
        status: "unknown",
        note: "Storage контур заполнен частично: нужен bucket, endpoint и secret ref"
      };
    }

    return {
      code: "storage",
      label: "Storage",
      status: "unknown",
      note: "Storage контур пока не настроен"
    };
  }

  private checkAiHealth(profile: any | null): DeployHealthItem {
    if (
      profile?.aiProvider &&
      profile?.aiModel &&
      this.hasSecretRef(profile?.aiSecretRef)
    ) {
      return {
        code: "ai",
        label: "AI контур",
        status: "unknown",
        note: `Настройки указаны (${profile.aiProvider} / ${profile.aiModel}), но подключение к AI еще не проверяется`
      };
    }

    if (profile?.aiProvider || profile?.aiModel || profile?.aiSecretRef) {
      return {
        code: "ai",
        label: "AI контур",
        status: "unknown",
        note: "AI контур заполнен частично: нужен provider, model и secret ref"
      };
    }

    return {
      code: "ai",
      label: "AI контур",
      status: "unknown",
      note: "AI контур пока не настроен"
    };
  }

  private getActivityTitle(action: string): string {
    switch (action) {
      case "client.created":
        return "Создан клиент";
      case "user.created":
        return "Создан первый админ";
      case "deploy_profile.created":
        return "Создан deploy profile";
      case "deploy_profile.updated":
        return "Обновлен deploy profile";
      case "deploy_workflow.marked":
        return "Изменен этап деплоя";
      case "deploy_run.started":
      case "deploy_bundle.started":
        return "Начата подготовка локального пакета";
      case "deploy_run.step":
      case "deploy_bundle.step":
        return "Шаг подготовки пакета";
      case "deploy_run.completed":
      case "deploy_bundle.created":
        return "Локальный пакет подготовлен";
      case "health_check.completed":
        return "Health-check завершен";
      default:
        return action;
    }
  }

  private getActivityNote(item: typeof schema.auditLog.$inferSelect): string {
    const details = (item.details ?? {}) as Record<string, unknown>;

    switch (item.action) {
      case "client.created":
        return this.joinActivityParts([
          typeof details.name === "string" ? details.name : null,
          typeof details.tariff === "string" ? `тариф ${details.tariff}` : null
        ]);
      case "user.created":
        return typeof details.email === "string" ? details.email : "Создан пользователь";
      case "deploy_profile.created":
        return this.joinActivityParts([
          typeof details.hostUrl === "string" ? details.hostUrl : null,
          typeof details.databaseHost === "string" ? `db ${details.databaseHost}` : null,
          typeof details.storageBucket === "string" ? `storage ${details.storageBucket}` : null
        ]);
      case "deploy_profile.updated":
        return this.joinActivityParts([
          typeof details.status === "string" ? `этап ${getDeployStatusLabel(details.status)}` : null,
          typeof details.hostUrl === "string" ? details.hostUrl : null,
          typeof details.databaseHost === "string" ? `db ${details.databaseHost}` : null
        ]);
      case "deploy_workflow.marked":
        return this.joinActivityParts([
          typeof details.previousStatus === "string"
            ? `было ${getDeployStatusLabel(details.previousStatus)}`
            : null,
          typeof details.status === "string" ? `статус ${getDeployStatusLabel(details.status)}` : null,
          typeof details.reason === "string" ? details.reason : null,
          typeof details.deploymentBundlePath === "string" ? details.deploymentBundlePath : null
        ]);
      case "deploy_run.started":
      case "deploy_bundle.started":
        return this.joinActivityParts([
          typeof details.status === "string" ? `старт из ${getDeployStatusLabel(details.status)}` : null,
          typeof details.stepCount === "number" ? `шагов ${details.stepCount}` : null
        ]);
      case "deploy_run.step":
      case "deploy_bundle.step":
        return this.joinActivityParts([
          typeof details.label === "string" ? details.label : null,
          typeof details.note === "string" ? details.note : null
        ]);
      case "deploy_run.completed":
      case "deploy_bundle.created":
        return this.joinActivityParts([
          typeof details.note === "string" ? details.note : null,
          typeof details.stepCount === "number" ? `шагов ${details.stepCount}` : null,
          typeof details.deploymentBundlePath === "string" ? details.deploymentBundlePath : null
        ]);
      case "health_check.completed":
        return this.joinActivityParts([
          typeof details.overallStatus === "string" ? `общий статус ${details.overallStatus}` : null,
          typeof details.healthyCount === "number" ? `healthy ${details.healthyCount}` : null,
          typeof details.degradedCount === "number" ? `частично ${details.degradedCount}` : null,
          typeof details.downCount === "number" ? `down ${details.downCount}` : null
        ]);
      default:
        return "Событие сохранено в audit log";
    }
  }

  private buildHealthHistory(
    auditItems: Array<typeof schema.auditLog.$inferSelect>
  ): DeployHealthHistoryItem[] {
    return auditItems
      .filter((item) => item.action === "health_check.completed")
      .slice(0, 5)
      .map((item) => {
        const details = (item.details ?? {}) as Record<string, unknown>;

        return {
          id: item.id,
          overallStatus:
            details.overallStatus === "healthy" ||
            details.overallStatus === "degraded" ||
            details.overallStatus === "down"
              ? details.overallStatus
              : "down",
          createdAt: item.createdAt.toISOString(),
          note: this.joinActivityParts([
            typeof details.healthyCount === "number" ? `healthy ${details.healthyCount}` : null,
            typeof details.degradedCount === "number" ? `частично ${details.degradedCount}` : null,
            typeof details.downCount === "number" ? `down ${details.downCount}` : null,
            typeof details.unknownCount === "number" ? `не проверено ${details.unknownCount}` : null
          ])
        };
      });
  }

  private joinActivityParts(parts: Array<string | null>): string {
    const filtered = parts.filter((item): item is string => Boolean(item && item.trim().length > 0));
    return filtered.length > 0 ? filtered.join(" • ") : "Детали сохранены в audit log";
  }

  private assertStatusTransition(
    currentStatus: string,
    nextStatus: DeployStatus,
    isValidationPassed: boolean
  ): void {
    if (nextStatus === DEPLOY_STATUSES.draft) {
      return;
    }

    if (nextStatus === DEPLOY_STATUSES.validated) {
      if (!isValidationPassed) {
        throw new BadRequestException(
          "Клиент не прошел проверку. Статус 'Проверено' можно ставить только после успешной validation."
        );
      }

      return;
    }

    if (nextStatus === DEPLOY_STATUSES.readyToDeploy) {
      if (!isValidationPassed) {
        throw new BadRequestException(
          "Клиент не прошел проверку. Статус 'Готово к деплою' нельзя ставить без успешной validation."
        );
      }

      if (currentStatus !== DEPLOY_STATUSES.validated) {
        throw new BadRequestException(
          "Статус 'Готово к деплою' можно поставить только после статуса 'Проверено'."
        );
      }

      return;
    }

    if (nextStatus === DEPLOY_STATUSES.deployed) {
      throw new BadRequestException(
        "Нельзя подтвердить 'Развернуто': удаленный запуск и проверка клиента еще не реализованы."
      );
    }
  }

  private async updateWorkflowStatus(
    clientId: string,
    nextStatus: DeployStatus
  ): Promise<{
    clientId: string;
    deployProfileId: string;
    status: string;
  }> {
    try {
      const [client] = await this.databaseService.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      const [existingProfile] = await this.databaseService.db
        .select()
        .from(deployProfiles)
        .where(eq(deployProfiles.clientId, clientId))
        .limit(1);

      if (!existingProfile) {
        throw new NotFoundException("Deploy profile not found");
      }

      const clientAdminRoleId = await this.getClientAdminRoleId();
      const [adminUser] = clientAdminRoleId
        ? await this.databaseService.db
            .select()
            .from(schema.users)
            .where(
              and(
                eq(schema.users.roleId, clientAdminRoleId),
                eq(schema.users.clientId, client.id)
              )
            )
            .limit(1)
        : [];

      const validation = this.buildValidation(client, adminUser?.email ?? null, existingProfile);
      this.assertStatusTransition(existingProfile.status, nextStatus, validation.isValid);

      const [profile] = await this.databaseService.db
        .update(deployProfiles)
        .set({
          status: nextStatus,
          updatedAt: new Date()
        })
        .where(eq(deployProfiles.clientId, clientId))
        .returning();

      await this.databaseService.db.insert(schema.auditLog).values({
        clientId,
        actorUserId: null,
        action: "deploy_workflow.marked",
        entityType: "deploy_profile",
        entityId: profile.id,
        details: {
          previousStatus: existingProfile.status,
          status: profile.status,
          reason: this.getWorkflowReason(profile.status)
        }
      });

      return {
        clientId,
        deployProfileId: profile.id,
        status: profile.status
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to update deploy workflow status", {
        cause: error
      });
    }
  }

  private getWorkflowReason(status: DeployStatus): string {
    switch (status) {
      case DEPLOY_STATUSES.draft:
        return "Возврат в черновик";
      case DEPLOY_STATUSES.validated:
        return "Проверка пройдена";
      case DEPLOY_STATUSES.readyToDeploy:
        return "Клиент подготовлен к деплою";
      case DEPLOY_STATUSES.deployed:
        return "Клиент отмечен как развернутый";
      default:
        return status;
    }
  }

  private buildDeployRunSteps(deploymentBundlePath: string): DeployRunStep[] {
    return [
      {
        code: "validate_profile",
        label: "Проверка профиля клиента",
        note: "Обязательные поля и текущая конфигурация прошли проверку"
      },
      {
        code: "copy_seed_data",
        label: "Копирование стартовых данных LMS",
        note: "Seed-файлы скопированы в локальную папку пакета"
      },
      {
        code: "write_configuration",
        label: "Запись конфигурации клиента",
        note: "Созданы manifest, локальный env-шаблон, AI- и theme-конфигурации"
      },
      {
        code: "write_bundle",
        label: "Сохранение локального пакета",
        note: deploymentBundlePath
      }
    ];
  }

  private async createDeploymentBundle(
    client: typeof schema.clients.$inferSelect,
    profile: any
  ): Promise<string> {
    const deploymentDir = path.join(GENERATED_DEPLOYMENTS_ROOT, client.slug);
    const deploymentManifestPath = path.join(deploymentDir, "deployment-manifest.json");
    const envFilePath = path.join(deploymentDir, ".env.lms");
    const aliceConfigPath = path.join(deploymentDir, "alice-ai-tenant.json");
    const themeConfigPath = path.join(deploymentDir, "theme-overrides.json");
    const seedDeploymentPath = path.join(deploymentDir, "seed");

    const tariffFeatures = getTariffFeatures(client.tariff);
    const theme = this.resolveThemePalette(client, profile);
    const previewUrl = this.buildPreviewUrl(client.id);
    const liveSiteUrl = this.buildLiveSiteUrl(profile);
    const sourcePath = profile?.lmsSourcePath ?? DEFAULT_LMS_SOURCE_PATH;
    const [previewSettingsRow] = await this.databaseService.db
      .select()
      .from(clientPreviewSettings)
      .where(eq(clientPreviewSettings.clientId, client.id))
      .limit(1);
    const previewSettings = previewSettingsRow
      ? this.toClientPreviewSettings(previewSettingsRow)
      : this.buildDefaultPreviewSettingsForClient(client, profile);

    const manifest = {
      generatedAt: new Date().toISOString(),
      client: {
        id: client.id,
        slug: client.slug,
        name: client.name,
        brandName: client.brandName,
        domain: client.domain,
        tariff: client.tariff,
        industryTemplate: client.industryTemplate,
        industryTemplateLabel: getIndustryTemplateLabel(client.industryTemplate),
        includedUsers: client.includedUsers,
        maxAdmins: client.maxAdmins,
        aiRequestsLimit: client.aiRequestsLimit
      },
      runtime: {
        sourcePath,
        seedDataPath: seedDeploymentPath,
        previewUrl,
        liveSiteUrl
      },
      host: {
        hostUrl: profile.hostUrl,
        deployPath: profile.deployPath
      },
      database: {
        host: profile.databaseHost,
        port: profile.databasePort,
        name: profile.databaseName,
        user: profile.databaseUser,
        passwordSecretRef: profile.databasePasswordSecretRef
      },
      storage: {
        bucket: profile.storageBucket,
        region: profile.storageRegion,
        endpoint: profile.storageEndpoint,
        secretRef: profile.storageSecretRef
      },
      ai: {
        provider: profile.aiProvider,
        model: profile.aiModel,
        secretRef: profile.aiSecretRef,
        aliceTenantCode: profile.aliceTenantCode ?? client.slug,
        aliceModelPreset: profile.aliceModelPreset ?? "alice-default"
      },
      theme,
      previewSettings,
      tariffFeatures
    };

    const envFile = [
      `CLIENT_ID=${client.id}`,
      `CLIENT_SLUG=${client.slug}`,
      `CLIENT_NAME=${client.name}`,
      `CLIENT_BRAND=${client.brandName}`,
      `CLIENT_DOMAIN=${client.domain}`,
      `CLIENT_INDUSTRY_TEMPLATE=${client.industryTemplate}`,
      `DEPLOY_TARGET_URL=${profile.hostUrl}`,
      `DEPLOY_PATH=${profile.deployPath ?? ""}`,
      `DATABASE_HOST=${profile.databaseHost}`,
      `DATABASE_PORT=${profile.databasePort}`,
      `DATABASE_NAME=${profile.databaseName}`,
      `DATABASE_USER=${profile.databaseUser}`,
      `DATABASE_PASSWORD_SECRET_REF=${profile.databasePasswordSecretRef ?? ""}`,
      `STORAGE_BUCKET=${profile.storageBucket}`,
      `STORAGE_REGION=${profile.storageRegion ?? ""}`,
      `STORAGE_ENDPOINT=${profile.storageEndpoint ?? ""}`,
      `STORAGE_SECRET_REF=${profile.storageSecretRef ?? ""}`,
      `AI_PROVIDER=${profile.aiProvider}`,
      `AI_MODEL=${profile.aiModel}`,
      `AI_SECRET_REF=${profile.aiSecretRef ?? ""}`,
      `ALICE_TENANT_CODE=${profile.aliceTenantCode ?? client.slug}`,
      `ALICE_MODEL_PRESET=${profile.aliceModelPreset ?? "alice-default"}`,
      `PREVIEW_THEME_PRIMARY=${theme.primary}`,
      `PREVIEW_THEME_ACCENT=${theme.accent}`,
      `PREVIEW_THEME_BACKGROUND=${theme.background}`,
      `PREVIEW_THEME_SURFACE=${theme.surface}`,
      `PREVIEW_URL=${previewUrl}`,
      `LIVE_SITE_URL=${liveSiteUrl ?? ""}`
    ].join("\n");

    await mkdir(deploymentDir, { recursive: true });
    await this.copyLmsSeedData(sourcePath, seedDeploymentPath);
    await writeFile(deploymentManifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await writeFile(envFilePath, `${envFile}\n`, "utf8");
    await writeFile(
      aliceConfigPath,
      JSON.stringify(
        {
          provider: profile.aiProvider,
          model: profile.aiModel,
          secretRef: profile.aiSecretRef ?? null,
          tenantCode: profile.aliceTenantCode ?? client.slug,
          preset: profile.aliceModelPreset ?? "alice-default"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      themeConfigPath,
      JSON.stringify(
        {
          brandName: client.brandName,
          palette: theme,
          settings: previewSettings,
          previewUrl,
          tariff: client.tariff
        },
        null,
        2
      ),
      "utf8"
    );

    return deploymentManifestPath;
  }

  private async copyLmsSeedData(sourcePath: string, targetPath: string): Promise<void> {
    const seedSourcePath = path.join(sourcePath, "data", "seed");

    if (!existsSync(seedSourcePath)) {
      await mkdir(targetPath, { recursive: true });
      await writeFile(
        path.join(targetPath, "README.md"),
        "Seed data was not found in LMS source. Expected path: data/seed.\n",
        "utf8"
      );
      return;
    }

    await mkdir(targetPath, { recursive: true });
    await cp(seedSourcePath, targetPath, {
      recursive: true,
      force: true
    });
  }

  private resolveThemePalette(
    client: typeof schema.clients.$inferSelect,
    profile: any | null
  ): DeployThemePalette {
    return {
      primary: profile?.previewThemePrimary ?? client.primaryColor ?? "#0abab5",
      accent: profile?.previewThemeAccent ?? "#6ee7d8",
      background: profile?.previewThemeBackground ?? "#071419",
      surface: profile?.previewThemeSurface ?? "#0f2229"
    };
  }

  private buildPreviewUrl(clientId: string): string {
    return `${DEFAULT_PREVIEW_HOST}/preview?clientId=${clientId}`;
  }

  private buildLiveSiteUrl(profile: any | null): string | null {
    if (!this.isValidUrl(profile?.hostUrl)) {
      return null;
    }

    return typeof profile?.deployPath === "string" && profile.deployPath.trim().length > 1
      ? `${profile.hostUrl}${profile.deployPath}`
      : profile.hostUrl;
  }

  private hasLmsSourcePath(profile: any | null): boolean {
    return Boolean(profile?.lmsSourcePath && existsSync(profile.lmsSourcePath));
  }

  private hasThemePalette(
    client: typeof schema.clients.$inferSelect,
    profile: any | null
  ): boolean {
    const theme = this.resolveThemePalette(client, profile);

    return [theme.primary, theme.accent, theme.background, theme.surface].every(
      (value) => typeof value === "string" && value.trim().length > 0
    );
  }

  private getThemeSummary(
    client: typeof schema.clients.$inferSelect,
    profile: any | null
  ): string {
    const theme = this.resolveThemePalette(client, profile);
    return `primary ${theme.primary} • accent ${theme.accent} • bg ${theme.background}`;
  }

  private isValidUrl(value: string | null | undefined): boolean {
    if (!value) {
      return false;
    }

    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  private isValidDeployPath(value: string | null | undefined): boolean {
    return Boolean(value && value.startsWith("/") && value.length > 1);
  }

  private hasDatabaseProfile(profile: any | null): boolean {
    return Boolean(
      profile?.databaseHost &&
        profile?.databasePort &&
        profile?.databaseName &&
        profile?.databaseUser
    );
  }

  private hasSecretRef(value: string | null | undefined): boolean {
    return Boolean(value && value.trim().length > 0);
  }

  private hasStorageProfile(profile: any | null): boolean {
    return Boolean(
      profile?.storageBucket &&
        this.hasSecretRef(profile?.storageSecretRef)
    );
  }

  private hasAiProfile(profile: any | null): boolean {
    return Boolean(
      profile?.aiProvider &&
        profile?.aiModel &&
        this.hasSecretRef(profile?.aiSecretRef)
    );
  }

  private async ensureClientExists(clientId: string): Promise<typeof schema.clients.$inferSelect> {
    const [client] = await this.databaseService.db
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.id, clientId))
      .limit(1);

    if (!client) {
      throw new NotFoundException("Client not found");
    }

    return client;
  }

  private toClientPreviewSettings(settingsRow: any): ClientPreviewSettings {
    return mergeClientPreviewSettings({
      version: 1,
      theme: settingsRow.theme,
      typography: settingsRow.typography,
      content: settingsRow.content,
      layout: settingsRow.layout,
      components: settingsRow.components,
      elementOverrides: settingsRow.elementOverrides
    });
  }

  private buildDefaultPreviewSettingsForClient(
    client: typeof schema.clients.$inferSelect,
    profile: any | null
  ): ClientPreviewSettings {
    const theme = this.resolveThemePalette(client, profile);

    return mergeClientPreviewSettings({
      ...DEFAULT_CLIENT_PREVIEW_SETTINGS,
      theme: {
        ...DEFAULT_CLIENT_PREVIEW_SETTINGS.theme,
        ...theme,
        button: theme.primary
      },
      content: {
        ...DEFAULT_CLIENT_PREVIEW_SETTINGS.content,
        homeTitle: client.brandName
      }
    });
  }

  private mergePreviewSettingsPayload(
    existingSettings: ClientPreviewSettings,
    payload: SavePreviewSettingsDto
  ): ClientPreviewSettings {
    return mergeClientPreviewSettings({
      version: 1,
      theme: {
        ...existingSettings.theme,
        ...(this.isPlainObject(payload.theme) ? payload.theme : {})
      },
      typography: {
        ...existingSettings.typography,
        ...(this.isPlainObject(payload.typography) ? payload.typography : {})
      },
      content: {
        ...existingSettings.content,
        ...(this.isPlainObject(payload.content) ? payload.content : {})
      },
      layout: {
        ...existingSettings.layout,
        ...(this.isPlainObject(payload.layout) ? payload.layout : {})
      },
      components: {
        ...existingSettings.components,
        ...(this.isPlainObject(payload.components) ? payload.components : {})
      },
      elementOverrides: this.isPlainObject(payload.elementOverrides)
        ? payload.elementOverrides
        : existingSettings.elementOverrides
    });
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private hashPassword(password: string): string {
    const salt = randomBytes(16).toString("hex");
    const derivedKey = scryptSync(password, salt, 64).toString("hex");

    return `${salt}:${derivedKey}`;
  }
}
