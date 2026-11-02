import { NextRequest, NextResponse } from "next/server";
import { forwardPanelValidation } from "../../panel-proxy";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return forwardPanelValidation(request);
}
