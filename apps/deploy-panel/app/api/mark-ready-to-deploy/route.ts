import { NextRequest, NextResponse } from "next/server";
import { forwardPanelPost } from "../../panel-proxy";

export async function POST(request: NextRequest): Promise<NextResponse> {
  return forwardPanelPost(request, "mark-ready-to-deploy", 15000);
}
