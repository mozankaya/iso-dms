import type { NotificationDto, PaginatedDto } from "@iso-dms/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { tr } from "@/lib/i18n/tr";
import { NotificationList } from "./notification-list";

const t = tr.notifications;

const replace = vi.fn();
const push = vi.fn();
let currentSearch = "";
const getNotifications = vi.fn();
const markNotificationRead = vi.fn();
const markAllNotificationsRead = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push }),
  usePathname: () => "/notifications",
  useSearchParams: () => new URLSearchParams(currentSearch),
}));
vi.mock("@/lib/api/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/endpoints")>()),
  getNotifications: (query: unknown) => getNotifications(query),
  markNotificationRead: (id: string) => markNotificationRead(id),
  markAllNotificationsRead: () => markAllNotificationsRead(),
}));

function item(overrides: Partial<NotificationDto> = {}): NotificationDto {
  return {
    id: "n1",
    type: "APPROVAL_STEP_WAITING",
    title: "Onayınızı bekleyen revizyon: PR-KK-001",
    body: "PR-KK-001 Doküman Kontrol Prosedürü için 1. adım onayınızı bekliyor (revizyon).",
    link: "/approvals",
    isRead: false,
    createdAt: "2026-10-08T09:30:00.000Z",
    ...overrides,
  };
}

function page(items: NotificationDto[], total = items.length): PaginatedDto<NotificationDto> {
  return { items, total, page: 1, pageSize: 20 };
}

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <NotificationList />
    </QueryClientProvider>,
  );
  return { invalidate };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentSearch = "";
  getNotifications.mockResolvedValue(page([item(), item({ id: "n2", title: "PR-KK-002 onaylandı ve yürürlüğe girdi", body: "Bitti.", link: "/documents/d2", isRead: true })]));
});

describe("NotificationList", () => {
  it("lists the messages with their text, marking the unread ones", async () => {
    renderList();

    const list = await screen.findByRole("list", { name: t.listLabel });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Onayınızı bekleyen revizyon: PR-KK-001")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/1\. adım onayınızı bekliyor/)).toBeInTheDocument();
    expect(within(rows[0]).getByRole("img", { name: t.unread })).toBeInTheDocument();
    expect(within(rows[1]).queryByRole("img", { name: t.unread })).not.toBeInTheDocument();
  });

  it("asks for the page and the filter the URL names", async () => {
    currentSearch = "status=unread&page=2";
    getNotifications.mockResolvedValue(page([item()], 45));
    renderList();

    await screen.findByRole("list", { name: t.listLabel });
    expect(getNotifications).toHaveBeenCalledWith({ status: "unread", page: 2, pageSize: 20 });
  });

  it("puts a chosen filter into the URL", async () => {
    renderList();
    await screen.findByRole("list", { name: t.listLabel });

    await userEvent.selectOptions(screen.getByLabelText(t.statusFilter), "unread");

    expect(replace).toHaveBeenCalledWith("/notifications?status=unread", { scroll: false });
  });

  it("marks an unread message as read and goes where it leads", async () => {
    markNotificationRead.mockResolvedValue(item({ isRead: true }));
    const { invalidate } = renderList();
    const list = await screen.findByRole("list", { name: t.listLabel });

    await userEvent.click(within(within(list).getAllByRole("listitem")[0]).getByRole("button"));

    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledWith("n1"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/approvals"));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["notifications"] });
  });

  it("goes where a message leads without asking again when it was read already", async () => {
    renderList();
    const list = await screen.findByRole("list", { name: t.listLabel });

    await userEvent.click(within(within(list).getAllByRole("listitem")[1]).getByRole("button"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/documents/d2"));
    expect(markNotificationRead).not.toHaveBeenCalled();
  });

  it("still goes there when marking fails, and says so", async () => {
    markNotificationRead.mockRejectedValue(new ApiError(500, "UNKNOWN"));
    renderList();
    const list = await screen.findByRole("list", { name: t.listLabel });

    await userEvent.click(within(within(list).getAllByRole("listitem")[0]).getByRole("button"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/approvals"));
    expect(await screen.findByRole("alert")).toHaveTextContent(tr.errors.UNKNOWN);
  });

  it("marks everything read", async () => {
    markAllNotificationsRead.mockResolvedValue({ count: 1 });
    const { invalidate } = renderList();
    await screen.findByRole("list", { name: t.listLabel });

    await userEvent.click(screen.getByRole("button", { name: t.markAllRead }));

    await waitFor(() => expect(markAllNotificationsRead).toHaveBeenCalled());
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["notifications"] }));
  });

  it("says so when there is nothing, or nothing unread", async () => {
    getNotifications.mockResolvedValue(page([]));
    renderList();
    expect(await screen.findByText(t.empty)).toBeInTheDocument();
  });

  it("says so when nothing is unread", async () => {
    currentSearch = "status=unread";
    getNotifications.mockResolvedValue(page([]));
    renderList();
    expect(await screen.findByText(t.emptyUnread)).toBeInTheDocument();
  });

  it("tells when the list cannot be loaded", async () => {
    getNotifications.mockRejectedValue(new ApiError(500, "UNKNOWN"));
    renderList();
    expect(await screen.findByRole("alert")).toHaveTextContent(t.loadError);
  });
});
