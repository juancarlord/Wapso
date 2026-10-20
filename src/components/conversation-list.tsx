'use client';

import { useEffect, useRef, useState, forwardRef, useImperativeHandle, useCallback } from 'react';
import { format, isValid, isToday, isYesterday } from 'date-fns';
import { RefreshCw, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAutoPolling } from '@/hooks/use-auto-polling';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { LogoutButton } from '@/components/logout-button';
import { ThemeToggle } from '@/components/theme-toggle';
import { NotificationsToggle, playPing } from '@/components/notifications-toggle';

type Conversation = {
  id: string;
  phoneNumber: string;
  status: string;
  lastActiveAt: string;
  phoneNumberId: string;
  bsuid?: string;
  username?: string | null;
  metadata?: Record<string, unknown>;
  contactName?: string;
  messagesCount?: number;
  lastInboundAt?: string;
  unread?: boolean;
  assignmentKey?: string;
  assignedUserId?: number | null;
  assignedName?: string | null;
  chatStatus?: 'open' | 'resolved';
  lastMessage?: {
    content: string;
    direction: string;
    type?: string;
  };
};

function formatConversationDate(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    if (!isValid(date)) return '';

    if (isToday(date)) return format(date, 'HH:mm');
    if (isYesterday(date)) return 'Ayer';
    return format(date, 'MMM d');
  } catch {
    return '';
  }
}

/** In-memory only (never leaves the page): stable per-contact key; merged conversation ids change when Kapso opens a new conversation for the same contact. */
function conversationKey(c: { id: string; phoneNumber?: string; contactName?: string }): string {
  return c.phoneNumber || c.contactName || c.id;
}

/** Latest inbound time: Kapso's last_inbound_at, or lastActiveAt when the last message is inbound. */
function latestInboundTime(c: { lastInboundAt?: string; lastActiveAt?: string; lastMessage?: { direction: string } }): number {
  const a = c.lastInboundAt ? Date.parse(c.lastInboundAt) : NaN;
  const b = c.lastMessage?.direction === 'inbound' && c.lastActiveAt ? Date.parse(c.lastActiveAt) : NaN;
  return Math.max(Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0);
}

function getAvatarInitials(contactName?: string, phoneNumber?: string): string {
  if (contactName) {
    const words = contactName.trim().split(/\s+/);
    if (words.length >= 2) {
      return (words[0][0] + words[1][0]).toUpperCase();
    }
    return contactName.slice(0, 2).toUpperCase();
  }

  if (phoneNumber) {
    const digits = phoneNumber.replace(/\D/g, '');
    return digits.slice(-2);
  }

  return '??';
}

type Tab = 'mine' | 'unassigned' | 'all' | 'resolved';
const TABS: { id: Tab; label: string }[] = [
  { id: 'mine', label: 'Mis chats' },
  { id: 'unassigned', label: 'Sin asignar' },
  { id: 'all', label: 'Todos' },
  { id: 'resolved', label: 'Resueltos' },
];

type Props = {
  onSelectConversation: (conversation: Conversation) => void;
  selectedConversationId?: string;
  isHidden?: boolean;
};

export type ConversationListRef = {
  refresh: () => Promise<Conversation[]>;
  selectByPhoneNumber: (phoneNumber: string) => void;
};

export const ConversationList = forwardRef<ConversationListRef, Props>(
  ({ onSelectConversation, selectedConversationId, isHidden = false }, ref) => {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tab, setTab] = useState<Tab>('all');
  const [myId, setMyId] = useState<number | null>(null);
  const myIdRef = useRef<number | null>(null);
  
  // Per-contact latest inbound time seen on the previous poll (null until seeded by the first load).
  const lastInboundRef = useRef<Map<string, number> | null>(null);
  const lastPingRef = useRef(0);
  const selectedRef = useRef(selectedConversationId);
  selectedRef.current = selectedConversationId;
  const onSelectRef = useRef(onSelectConversation);
  onSelectRef.current = onSelectConversation;

  const markRead = useCallback((id: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unread: false } : c)));
    fetch('/api/conversations/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: id }),
    }).catch(() => {});
  }, []);

  // Detect new inbound messages between polls, per conversation: notify, or mark read if it's open and visible.
  const handleNewInbound = useCallback((incoming: Conversation[]) => {
    const prev = lastInboundRef.current;
    const next = new Map<string, number>();
    for (const c of incoming) {
      const t = latestInboundTime(c);
      if (t > 0) next.set(conversationKey(c), t);
    }
    // Keep marks for contacts not on this page so they don't re-fire later.
    if (prev) for (const [k, v] of prev) if (!next.has(k)) next.set(k, v);
    lastInboundRef.current = next;
    if (!prev) return; // first load seeds the baseline: nothing fires for old messages

    const selectedKeyIds = selectedRef.current ? selectedRef.current.split(',') : [];
    let fired = false;
    for (const c of incoming) {
      const key = conversationKey(c);
      const t = next.get(key);
      if (t === undefined || t <= (prev.get(key) ?? 0)) continue;
      const isOpen = c.id.split(',').some((id) => selectedKeyIds.includes(id));
      if (isOpen && !document.hidden) {
        markRead(c.id);
        continue;
      }
      // Assigned chats notify only the assigned user; unassigned chats notify everyone.
      if (c.assignedUserId != null && c.assignedUserId !== myIdRef.current) continue;
      fired = true;
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        // Privacy: contact name only (never phone number or message body). One notification per conversation (tag = conversation id, never the phone).
        const n = new Notification(c.contactName?.trim() || 'WhatsApp', { body: 'Nuevo mensaje', tag: `conv-${c.id.split(',')[0]}` });
        n.onclick = () => {
          window.focus();
          markRead(c.id);
          onSelectRef.current(c);
          n.close();
        };
      }
    }
    // Beep at most once every 5 s.
    if (fired && Date.now() - lastPingRef.current >= 5000) {
      lastPingRef.current = Date.now();
      playPing();
    }
  }, [markRead]);

  const fetchConversations = useCallback(async (after?: string) => {
    try {
      // only show initial "loading" on first load; avoid toggling UI for background polls
      if (!after && !hasLoaded) {
        setLoading(true);
      } else if (after) {
        setLoadingMore(true);
      }

      const url = new URL('/api/conversations', window.location.origin);
      if (after) url.searchParams.set('after', after);
      // optional: url.searchParams.set('limit', '100');

      console.log('[FE] GET', url.toString());
      const res = await fetch(url.toString());
      const json = await res.json();
      console.log('[FE] /api/conversations response paging:', json.paging, 'items:', json.data?.length);

      if (after) {
        // append new page, avoid duplicates
        setConversations(prev => {
          const existingIds = new Set(prev.map((c) => c.id));
          const newItems = (json.data || []).filter((c: Conversation) => !existingIds.has(c.id));
          return [...prev, ...newItems];
        });
      } else {
        // merge first-page results with already-loaded later pages:
        setConversations(prev => {
          const incoming: Conversation[] = json.data || [];
          const incomingIds = new Set(incoming.map(i => i.id));
  
          // build map of existing by id
          const existingMap = new Map(prev.map(p => [p.id, p]));
  
          // for items in incoming, prefer incoming data but keep unspecified fields from existing
          const merged = incoming.map((item) => {
            const existing = existingMap.get(item.id);
            return existing ? { ...existing, ...item } : item;
          });
  
          // append tail items previously loaded (later pages) that weren't in incoming
          const tail = prev.filter(p => !incomingIds.has(p.id));
          return [...merged, ...tail];
        });
      }

      if (typeof json.me === 'number') { myIdRef.current = json.me; setMyId(json.me); }
      if (!after && Array.isArray(json.data)) handleNewInbound(json.data as Conversation[]);
      setNextCursor(json.paging?.after ?? json.paging?.next ?? null);
    } catch (err) {
      console.error('[FE] fetchConversations error', err);
    } finally {
      if (!hasLoaded) setHasLoaded(true);
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, [hasLoaded, handleNewInbound]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const handleRefresh = () => {
    setRefreshing(true);
    // explicit refresh should show only the small refresh spinner, not full skeleton
    fetchConversations().finally(() => setRefreshing(false));
  };

  // Poll every 10 s when visible, every 30 s when the tab is hidden.
  const [tabHidden, setTabHidden] = useState(false);
  useEffect(() => {
    const onVis = () => setTabHidden(document.hidden);
    onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  const { isPolling } = useAutoPolling({
    interval: tabHidden ? 30000 : 10000,
    enabled: true,
    pauseWhenHidden: false, // keep polling in background tabs so notifications work
    onPoll: fetchConversations
  });

  const selectByPhoneNumber = (phoneNumber: string) => {
    const conversation = conversations.find(conv => conv.phoneNumber === phoneNumber);
    if (conversation) {
      onSelectConversation(conversation);
    }
  };

  useImperativeHandle(ref, () => ({
    refresh: async () => {
      setRefreshing(true);
      await fetchConversations();
      setRefreshing(false);
      return conversations;
    },
    selectByPhoneNumber
  }));

  // Tab title with this user's unread count.
  const unreadCount = conversations.filter((c) => c.unread).length;
  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount}) Bandeja` : 'Bandeja';
  }, [unreadCount]);

  const openConversation = (c: Conversation) => {
    if (c.unread) markRead(c.id);
    onSelectConversation(c);
  };

  const inTab = (c: Conversation) => {
    const resolved = c.chatStatus === 'resolved';
    if (tab === 'resolved') return resolved;
    if (resolved) return false;
    if (tab === 'mine') return myId != null && c.assignedUserId === myId;
    if (tab === 'unassigned') return c.assignedUserId == null;
    return true;
  };
  const tabCount = (t: Tab) => conversations.filter((c) => {
    const resolved = c.chatStatus === 'resolved';
    if (t === 'resolved') return resolved;
    if (resolved) return false;
    if (t === 'mine') return myId != null && c.assignedUserId === myId;
    if (t === 'unassigned') return c.assignedUserId == null;
    return true;
  }).length;

  const filteredConversations = conversations.filter((conv) => {
    if (!inTab(conv)) return false;
    const query = searchQuery.toLowerCase();
    return (
      conv.phoneNumber.toLowerCase().includes(query) ||
      conv.contactName?.toLowerCase().includes(query)
    );
  });

  if (loading) {
    return (
      <div className={cn(
        "w-full md:w-96 border-r border-line bg-surface flex flex-col",
        isHidden && "hidden md:flex"
      )}>
        <div className="p-4 border-b border-line bg-panel">
          <div className="flex items-center justify-between mb-3">
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-9 w-24" />
          </div>
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
        <div className="flex-1 p-3 space-y-3">
          {[1, 2, 3, 4, 5, 6, 7].map((i) => (
            <div key={i} className="flex gap-3 p-3">
              <Skeleton className="h-12 w-12 rounded-full flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      "w-full md:w-96 border-r border-line bg-surface flex flex-col",
      isHidden && "hidden md:flex"
    )}>
      <div className="p-4 border-b border-line bg-panel">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-fg">Chats</h1>
            {isPolling && (
              <div
                className="h-2 w-2 rounded-full bg-green-500 animate-pulse"
                title="Actualización automática"
                aria-hidden="true"
              />
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              onClick={handleRefresh}
              disabled={refreshing}
              variant="ghost"
              size="icon"
              className="text-muted-fg hover:bg-line/30"
              title="Actualizar"
              aria-label="Actualizar conversaciones"
            >
              <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
            </Button>
            <NotificationsToggle />
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-fg" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar chat"
            aria-label="Buscar chat"
            className="pl-9 bg-surface border-line focus-visible:ring-brand rounded-lg"
          />
        </div>
        <div role="tablist" aria-label="Filtrar chats" className="mt-3 grid grid-cols-4 gap-1 rounded-lg bg-surface p-1 border border-line">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'rounded-md px-1 py-1 text-xs font-medium transition-colors truncate',
                tab === t.id ? 'bg-brand text-white' : 'text-muted-fg hover:bg-line/30'
              )}
            >
              {t.label} <span className="opacity-75">{tabCount(t.id)}</span>
            </button>
          ))}
        </div>
      </div>

      <ScrollArea className="flex-1 h-0 overflow-hidden">
        {filteredConversations.length === 0 ? (
          <div className="p-4 text-center text-muted-fg">
            {searchQuery ? 'No se encontraron conversaciones' : conversations.length ? 'No hay chats en esta vista' : 'Aún no hay conversaciones'}
          </div>
        ) : (
          <div className="w-full overflow-hidden">
          {filteredConversations.map((conversation) => (
            <button
              key={conversation.id}
              onClick={() => openConversation(conversation)}
              aria-current={selectedConversationId === conversation.id ? 'true' : undefined}
              className={cn(
                'w-full p-3 pr-4 border-b border-line-soft hover:bg-panel text-left transition-colors relative overflow-hidden',
                selectedConversationId === conversation.id && 'bg-panel'
              )}
            >
              <div className="flex gap-3 items-start overflow-hidden">
                <Avatar className="h-12 w-12 flex-shrink-0">
                  <AvatarFallback className="bg-line text-fg text-sm font-medium">
                    {getAvatarInitials(conversation.contactName, conversation.phoneNumber)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0 flex justify-between items-start gap-4 overflow-hidden">
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <p className={cn('text-fg truncate flex items-center gap-2', conversation.unread ? 'font-bold' : 'font-medium')}>
                      <span className="truncate">
                        {conversation.contactName || (conversation.username ? `@${conversation.username}` : conversation.phoneNumber)}
                      </span>
                      {conversation.unread && (
                        <>
                          <span className="h-2.5 w-2.5 rounded-full bg-brand-text flex-shrink-0" aria-hidden="true" />
                          <span className="sr-only">sin leer</span>
                        </>
                      )}
                    </p>
                    {conversation.contactName && conversation.username && (
                      <p className="text-sm text-muted-fg truncate mt-0.5">
                        @{conversation.username}
                      </p>
                    )}
                    {conversation.contactName && !conversation.username && conversation.phoneNumber && (
                      <p className="text-sm text-muted-fg truncate mt-0.5">
                        {conversation.phoneNumber}
                      </p>
                    )}
                    {conversation.lastMessage && (
                      <p className="text-sm text-muted-fg truncate mt-0.5">
                        {conversation.lastMessage.direction === 'outbound' && (
                          <span className="text-tick">✓ </span>
                        )}
                        {conversation.lastMessage.content}
                      </p>
                    )}
                    <p className={cn('text-xs truncate mt-0.5', conversation.assignedUserId != null ? 'text-brand-text' : 'text-muted-fg italic')}>
                      {conversation.assignedUserId != null
                        ? (conversation.assignedUserId === myId ? 'Asignado a ti' : `Asignado a ${conversation.assignedName ?? 'Usuario eliminado'}`)
                        : 'Sin asignar'}
                    </p>
                  </div>
                  <span className="text-xs text-muted-fg flex-shrink-0 mt-0.5 ml-4">
                    {formatConversationDate(conversation.lastActiveAt)}
                  </span>
                </div>
              </div>
            </button>
          ))
          }
          <div className="p-3 text-center">
            {nextCursor ? (
              <Button
                onClick={() => fetchConversations(nextCursor)}
                disabled={loadingMore}
                aria-disabled={loadingMore ? true : undefined}
              >
                {loadingMore ? 'Cargando...' : 'Cargar más'}
              </Button>
            ) : (
              <Button disabled variant="ghost" className="text-sm text-muted-fg" aria-disabled>
                No hay más conversaciones
              </Button>
            )}
          </div>
          </div>
        )}
      </ScrollArea>
    </div>
  );
});

ConversationList.displayName = 'ConversationList';
