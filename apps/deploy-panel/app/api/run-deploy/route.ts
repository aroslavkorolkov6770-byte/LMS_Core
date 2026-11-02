import { NextRequest, NextResponse } from "next/server";
import { forwardPanelPost } from "../../panel-proxy";

export async function POST(request: NextRequest): Promise<NextResponse> {
  return forwardPanelPost(request, "run-deploy", 110000);
}
