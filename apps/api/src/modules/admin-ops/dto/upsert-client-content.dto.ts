import { Allow } from "class-validator";

import { GetClientContentDto } from "./get-client-content.dto";

export class UpsertClientContentDto extends GetClientContentDto {
  @Allow()
  payload!: unknown;
}
