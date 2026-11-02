import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { AcknowledgementsModule } from "./modules/acknowledgements/acknowledgements.module";
import { AdminCalendarNotesModule } from "./modules/admin-calendar-notes/admin-calendar-notes.module";
import { AdminOpsModule } from "./modules/admin-ops/admin-ops.module";
import { AiHistoryModule } from "./modules/ai-history/ai-history.module";
import { AiModule } from "./modules/ai/ai.module";
import { AuditModule } from "./modules/audit/audit.module";
import { AuthModule } from "./modules/auth/auth.module";
import { ClientsModule } from "./modules/clients/clients.module";
import { CoursesModule } from "./modules/courses/courses.module";
import { DocumentsModule } from "./modules/documents/documents.module";
import { DeadlinesModule } from "./modules/deadlines/deadlines.module";
import { DatabaseModule } from "./modules/database/database.module";
import { DeployPanelModule } from "./modules/deploy-panel/deploy-panel.module";
import { DismissedTasksModule } from "./modules/dismissed-tasks/dismissed-tasks.module";
import { DocumentFilesModule } from "./modules/document-files/document-files.module";
import { ExportsModule } from "./modules/exports/exports.module";
import { HealthModule } from "./modules/health/health.module";
import { LearningContentModule } from "./modules/learning-content/learning-content.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { ProgressModule } from "./modules/progress/progress.module";
import { PushSubscriptionsModule } from "./modules/push-subscriptions/push-subscriptions.module";
import { TestsModule } from "./modules/tests/tests.module";
import { TestAttemptsModule } from "./modules/test-attempts/test-attempts.module";
import { UserProfileDataModule } from "./modules/user-profile-data/user-profile-data.module";
import { UsersModule } from "./modules/users/users.module";
import { appConfig } from "./config/app.config";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig]
    }),
    AcknowledgementsModule,
    AdminCalendarNotesModule,
    AuditModule,
    DatabaseModule,
    HealthModule,
    AuthModule,
    ClientsModule,
    UsersModule,
    CoursesModule,
    LearningContentModule,
    DeadlinesModule,
    TestsModule,
    TestAttemptsModule,
    DocumentsModule,
    DocumentFilesModule,
    DeployPanelModule,
    DismissedTasksModule,
    ProgressModule,
    PushSubscriptionsModule,
    AiHistoryModule,
    AiModule,
    NotificationsModule,
    UserProfileDataModule,
    ExportsModule,
    AdminOpsModule
  ]
})
export class AppModule {}
