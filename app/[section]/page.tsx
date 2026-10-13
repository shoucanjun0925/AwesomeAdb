import { notFound } from "next/navigation";
import { requireChatGPTUser } from "../chatgpt-auth";
import Workspace from "../workspace";
import { modules } from "../../shared/contracts";
export const dynamic = "force-dynamic";
export default async function ModulePage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (section !== "settings" && !modules.some((m) => m.id === section))
    notFound();
  const user = await requireChatGPTUser("/" + section);
  return <Workspace displayName={user.displayName} initialSection={section} />;
}
