import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { CreateCourseDto } from "./dto/create-course.dto";
import { ListCoursesDto } from "./dto/list-courses.dto";
import { CoursesService } from "./courses.service";

@Controller("courses")
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  @Get()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listCourses(@Query() query: ListCoursesDto): Promise<{
    items: Array<unknown>;
  }> {
    return this.coursesService.listCoursesForActor(
      query,
      {
        userId: "system-process",
        clientId: "",
        roleCode: ROLE_CODES.systemAdmin
      }
    );
  }

  @Get("scoped")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listScopedCourses(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: ListCoursesDto
  ): Promise<{
    items: Array<unknown>;
  }> {
    return this.coursesService.listCoursesForActor(query, currentUser);
  }

  @Get("meta")
  getMeta(): { module: string; status: string; scopedRoute: string } {
    return this.coursesService.getMeta();
  }

  @Post()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async createCourse(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: CreateCourseDto
  ): Promise<{
    item: unknown;
  }> {
    return this.coursesService.createCourseForActor(payload, currentUser);
  }
}
