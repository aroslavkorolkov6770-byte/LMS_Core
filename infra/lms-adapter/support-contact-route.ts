import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const candidate = process.env.SUPPORT_EMAIL || process.env.SMTP_USER || "";
    const supportEmail = candidate.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(candidate) ? candidate : null;
    // This public contract deliberately exposes only the contact address, never the SMTP environment.
    return NextResponse.json({ protocol: "lms-core-support-contact-v1", supportEmail }, { headers: { "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return NextResponse.json({ protocol: "lms-core-support-contact-v1", supportEmail: null }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
