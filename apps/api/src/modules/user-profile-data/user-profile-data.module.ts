import { Module } from "@nestjs/common";

import { UserProfileDataController } from "./user-profile-data.controller";
import { UserProfileDataService } from "./user-profile-data.service";

@Module({
  controllers: [UserProfileDataController],
  providers: [UserProfileDataService]
})
export class UserProfileDataModule {}
