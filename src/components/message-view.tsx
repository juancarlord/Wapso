'use client';

import { formatBytes } from '@/lib/media-text';

import { useEffect, useState, useRef, useCallback } from 'react';
import { format, isValid, isToday, isYesterday, differenceInHours } from 'date-fns';
import { RefreshCw, Paperclip, Send, X, AlertCircle, MessageSquare, XCircle, ListTree, ArrowLeft, Clock, Check, CheckCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MediaMessage, mediaKindFrom } from '@/components/media-message';
import { TemplateSelectorDialog } from '@/components/template-selector-dialog';
import { InteractiveMessageDialog } from '@/components/interactive-message-dialog';
import { useAutoPolling } from '@/hooks/use-auto-polling';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { ImageViewer, isViewerSafeSrc, type ViewerImage } from '@/components/image-viewer';
import type { MediaData } from '@kapso/whatsapp-cloud-api';
import { AssignmentBar, type ChatAssignment, type Me } from '@/components/assignment-bar';

type PendingMessage = {
  localId: string;
  conversationId: string;
  waId?: string;
  content: string;
  file?: File;
  previewUrl?: string;
  status: 'sending' | 'sent' | 'failed';
  createdAt: string;
};

function sentIdFrom(result: unknown): string | undefined {
  const msgs = (result as { messages?: Array<{ id?: unknown }> } | null)?.messages;
  const id = Array.isArray(msgs) ? msgs[0]?.id : undefined;
  return typeof id === 'string' ? id : undefined;
}

/** Outgoing status icon with an accessible label. */
function StatusIcon({ status }: { status?: string }) {
  if (status === 'sending' || status === 'pending' || status === 'queued') {
    return <Clock className="h-3.5 w-3.5 text-muted-fg" aria-label="Enviando" role="img" />;
  }
  if (status === 'failed') return <XCircle className="h-3.5 w-3.5 text-red-500" aria-label="No enviado" role="img" />;
  if (status === 'read') return <CheckCheck className="h-3.5 w-3.5 text-tick" aria-label="Leído" role="img" />;
  if (status === 'delivered') return <CheckCheck className="h-3.5 w-3.5 text-muted-fg" aria-label="Entregado" role="img" />;
  if (status === 'sent') return <Check className="h-3.5 w-3.5 text-muted-fg" aria-label="Enviado" role="img" />;
  return null;
}

type Message = {
  id: string;
  direction: 'inbound' | 'outbound';
  content: string;
  senderName?: string;
  createdAt: string;
  status?: string;
  phoneNumber: string;
  hasMedia: boolean;
  mediaData?: {
    url: string;
    contentType?: string;
    filename?: string;
    sizeText?: string;
  } | (MediaData & { url: string; sizeText?: string });
  reactionEmoji?: string | null;
  reactedToMessageId?: string | null;
  filename?: string | null;
  mimeType?: string | null;
  messageType?: string;
  caption?: string | null;
  metadata?: {
    mediaId?: string;
    caption?: string;
  };
};

function formatMessageTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    if (isValid(date)) {
      return format(date, 'HH:mm');
    }
    return '';
  } catch {
    return '';
  }
}

function formatDateDivider(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    if (!isValid(date)) return '';

    if (isToday(date)) return 'Today';
    if (isYesterday(date)) return 'Yesterday';
    return format(date, 'MMMM d, yyyy');
  } catch {
    return '';
  }
}

function shouldShowDateDivider(currentMsg: Message, prevMsg: Message | null): boolean {
  if (!prevMsg) return true;

  try {
    const currentDate = new Date(currentMsg.createdAt);
    const prevDate = new Date(prevMsg.createdAt);

    if (!isValid(currentDate) || !isValid(prevDate)) return false;

    return format(currentDate, 'yyyy-MM-dd') !== format(prevDate, 'yyyy-MM-dd');
  } catch {
    return false;
  }
}

function isWithin24HourWindow(messages: Message[]): boolean {
  // Find the last inbound message
  const inboundMessages = messages.filter(msg => msg.direction === 'inbound');

  if (inboundMessages.length === 0) {
    // No inbound messages yet - only templates allowed
    return false;
  }

  const lastInboundMessage = inboundMessages[inboundMessages.length - 1];

  try {
    const lastMessageDate = new Date(lastInboundMessage.createdAt);
    if (!isValid(lastMessageDate)) return false;

    const hoursSinceLastMessage = differenceInHours(new Date(), lastMessageDate);
    return hoursSinceLastMessage < 24;
  } catch {
    return false; // In case of error, only allow templates
  }
}

function getDisabledInputMessage(messages: Message[]): string {
  const inboundMessages = messages.filter(msg => msg.direction === 'inbound');

  if (inboundMessages.length === 0) {
    return 'Este contacto aún no te ha escrito. Envía una plantilla o espera su respuesta.';
  }

  return 'El último mensaje fue hace más de 24 horas. Envía una plantilla o espera a que el contacto te escriba.';
}

type Props = {
  conversationId?: string;
  phoneNumber?: string;
  bsuid?: string;
  username?: string | null;
  contactName?: string;
  onTemplateSent?: (phoneNumber: string) => Promise<void>;
  onBack?: () => void;
  isVisible?: boolean;
  onAssignmentChange?: () => void;
};

export function MessageView({ conversationId, phoneNumber, bsuid, username, contactName, onTemplateSent, onBack, isVisible = false, onAssignmentChange }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [messageInput, setMessageInput] = useState('');
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [myName, setMyName] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [canSendRegularMessage, setCanSendRegularMessage] = useState(true);
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [showInteractiveDialog, setShowInteractiveDialog] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  // Close the viewer when switching conversations.
  useEffect(() => { setViewerIndex(null); }, [conversationId]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previousMessageCountRef = useRef(0);

  // Chat assignment, keyed per contact exactly like the list (phone, else name, else first id).
  const assignmentKey = conversationId ? (phoneNumber || contactName || conversationId.split(',')[0]) : undefined;
  const [assignment, setAssignment] = useState<ChatAssignment | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [assignBusy, setAssignBusy] = useState(false);
  const loadAssignment = useCallback(async () => {
    if (!assignmentKey) return;
    try {
      const r = await fetch(`/api/assignments?key=${encodeURIComponent(assignmentKey)}`);
      if (!r.ok) return;
      const j = await r.json();
      if (j.assignment?.key === assignmentKey) { setAssignment(j.assignment); setMe(j.me); }
    } catch {}
  }, [assignmentKey]);
  useEffect(() => { setAssignment(null); loadAssignment(); }, [loadAssignment]);
  const assignAction = async (action: 'take' | 'release' | 'transfer' | 'resolve' | 'reopen', userId?: number) => {
    if (!assignmentKey) return;
    setAssignBusy(true);
    try {
      const r = await fetch('/api/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: assignmentKey, action, userId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) alert(j.error || 'No se pudo actualizar el chat');
      if (j.assignment) setAssignment(j.assignment);
      else await loadAssignment();
      onAssignmentChange?.();
    } finally {
      setAssignBusy(false);
    }
  };
  /** Warn before replying in a chat assigned to someone else. */
  const confirmReply = () => {
    if (!assignment || !me || assignment.assignedUserId == null || assignment.assignedUserId === me.id) return true;
    return window.confirm(`Este chat está asignado a ${assignment.assignedName ?? 'otro usuario'}. ¿Responder de todos modos?`);
  };

  useEffect(() => {
    fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null)).then((me) => setMyName(me?.name || me?.username || null)).catch(() => {});
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const fetchMessages = useCallback(async () => {
    if (!conversationId) return;

    try {
      const response = await fetch(`/api/messages/${conversationId}`);
      const data = await response.json();

      // Separate reactions from regular messages
      const reactions = (data.data || []).filter((msg: Message) => msg.messageType === 'reaction');
      const regularMessages = (data.data || []).filter((msg: Message) => msg.messageType !== 'reaction');

      // Create a map of message ID to reaction emoji
      const reactionMap = new Map<string, string>();
      reactions.forEach((reaction: Message) => {
        if (reaction.reactedToMessageId && reaction.reactionEmoji) {
          reactionMap.set(reaction.reactedToMessageId, reaction.reactionEmoji);
        }
      });

      // Attach reactions to their corresponding messages
      const messagesWithReactions = regularMessages.map((msg: Message) => {
        const reaction = reactionMap.get(msg.id);
        return reaction ? { ...msg, reactionEmoji: reaction } : msg;
      });

      const sortedMessages = messagesWithReactions.sort((a: Message, b: Message) => {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });

      setMessages(sortedMessages);
      const serverIds = new Set(sortedMessages.map((m: Message) => m.id));
      setPending((prev) => {
        const keep = prev.filter((p) => !(p.waId && serverIds.has(p.waId)));
        prev.filter((p) => !keep.includes(p) && p.previewUrl).forEach((p) => URL.revokeObjectURL(p.previewUrl!));
        return keep.length === prev.length ? prev : keep;
      });
      previousMessageCountRef.current = sortedMessages.length;
    } catch (error) {
      console.error('Error fetching messages:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (conversationId) {
      setLoading(true);
      fetchMessages();
    }
  }, [conversationId, fetchMessages]);

  useEffect(() => {
    // Only auto-scroll if user is near bottom
    if (isNearBottom) {
      scrollToBottom();
    }
  }, [messages, pending, isNearBottom]);

  useEffect(() => {
    setCanSendRegularMessage(isWithin24HourWindow(messages));
  }, [messages]);

  // Track if user is near bottom of scroll
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
      if (!viewport) return;

      const { scrollTop, scrollHeight, clientHeight } = viewport;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      setIsNearBottom(distanceFromBottom < 100);
    };

    const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
    if (viewport) {
      viewport.addEventListener('scroll', handleScroll);
      return () => viewport.removeEventListener('scroll', handleScroll);
    }
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchMessages();
    loadAssignment();
  };

  // Auto-polling for messages (every 5 seconds)
  useAutoPolling({
    interval: 5000,
    enabled: !!conversationId,
    onPoll: fetchMessages
  });
  // Keep the assignment bar in sync with changes made by other users.
  useAutoPolling({
    interval: 15000,
    enabled: !!assignmentKey,
    onPoll: loadAssignment
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSelectedFile(file);

    // Create preview for images
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setFilePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    } else {
      setFilePreview(null);
    }
  };

  const handleRemoveFile = () => {
    setSelectedFile(null);
    setFilePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Guards against double sends: one request per local message at a time.
  const inFlightRef = useRef<Set<string>>(new Set());

  const sendPending = useCallback(async (p: PendingMessage, to: string) => {
    if (inFlightRef.current.has(p.localId)) return;
    inFlightRef.current.add(p.localId);
    setPending((prev) => prev.map((x) => (x.localId === p.localId ? { ...x, status: 'sending' } : x)));
    try {
      const formData = new FormData();
      formData.append('to', to);
      if (p.content) formData.append('body', p.content);
      if (p.file) formData.append('file', p.file);
      const response = await fetch('/api/messages/send', { method: 'POST', body: formData });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const waId = sentIdFrom(await response.json().catch(() => null));
      setPending((prev) => prev.map((x) => (x.localId === p.localId ? { ...x, status: 'sent', waId } : x)));
      fetchMessages();
    } catch (error) {
      console.error('Error sending message:', error);
      setPending((prev) => prev.map((x) => (x.localId === p.localId ? { ...x, status: 'failed' } : x)));
    } finally {
      inFlightRef.current.delete(p.localId);
    }
  }, [fetchMessages]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    const content = messageInput.trim() ? messageInput : '';
    if (!content && !selectedFile) return;
    if (!confirmReply()) return;
    if (!conversationId || (!phoneNumber && !bsuid)) {
      alert('Esta conversación no tiene un número o usuario válido para enviar.');
      return;
    }
    const p: PendingMessage = {
      localId: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      conversationId,
      content,
      file: selectedFile ?? undefined,
      previewUrl: selectedFile ? URL.createObjectURL(selectedFile) : undefined,
      status: 'sending',
      createdAt: new Date().toISOString(),
    };
    setPending((prev) => [...prev, p]);
    // Clear right away so the agent can keep typing and send several in a row.
    setMessageInput('');
    handleRemoveFile();
    setIsNearBottom(true);
    sendPending(p, phoneNumber || bsuid || '');
  };

  const retryPending = (p: PendingMessage) => {
    if (p.status !== 'failed') return; // only failed messages can be retried
    sendPending(p, phoneNumber || bsuid || '');
  };

  const visiblePending = pending.filter((p) => p.conversationId === conversationId);

  // Every image in this conversation (server + optimistic), in display order, for the viewer.
  const viewerImages: ViewerImage[] = [
    ...messages.flatMap((m): ViewerImage[] => {
      const src = m.mediaData?.url || (m.metadata?.mediaId ? `/api/media/${encodeURIComponent(m.metadata.mediaId)}` : undefined);
      const mime = m.mediaData?.contentType || m.mimeType;
      if (!src || !isViewerSafeSrc(src) || mediaKindFrom(m.messageType, mime) !== 'image') return [];
      const filename = m.mediaData?.filename || m.filename || null;
      const sender = m.direction === 'outbound'
        ? (m.senderName ? `Enviado por ${m.senderName}` : 'Enviado')
        : (contactName || (username ? `@${username}` : phoneNumber) || 'Contacto');
      return [{ src, alt: `Imagen${filename ? ` ${filename}` : ''}`, filename, sender, createdAt: m.createdAt }];
    }),
    ...visiblePending.flatMap((p): ViewerImage[] =>
      p.file && p.previewUrl && mediaKindFrom(undefined, p.file.type) === 'image'
        ? [{ src: p.previewUrl, alt: `Imagen ${p.file.name}`, filename: p.file.name, sender: myName ? `Enviado por ${myName}` : 'Enviado', createdAt: p.createdAt }]
        : []),
  ];
  const openViewer = (src: string) => {
    const i = viewerImages.findIndex((v) => v.src === src);
    if (i >= 0) setViewerIndex(i);
  };

  const handleTemplateSent = async () => {
    await fetchMessages();

    // Notify parent to refresh conversation list and select this conversation
    if (phoneNumber && onTemplateSent) {
      await onTemplateSent(phoneNumber);
    }
  };


  if (!conversationId) {
    return (
      <div className={cn(
        "relative flex-1 flex items-center justify-center bg-chat-bg",
        !isVisible && "hidden md:flex"
      )}>
        <div className="chat-watermark" aria-hidden="true" />
        <p className="relative text-muted-fg">Selecciona una conversación para ver los mensajes</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={cn(
        "flex-1 flex flex-col bg-chat-bg",
        !isVisible && "hidden md:flex"
      )}>
        <div className="p-3 border-b border-line bg-panel">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 flex-1">
              {onBack && (
                <Button
                  onClick={onBack}
                  variant="ghost"
                  size="icon"
                  className="md:hidden text-muted-fg hover:bg-panel"
                >
                  <ArrowLeft className="h-5 w-5" />
                </Button>
              )}
              <div className="flex-1">
                <Skeleton className="h-5 w-40 mb-1" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
            <Skeleton className="h-9 w-24 rounded-lg" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="max-w-[900px] mx-auto space-y-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className={cn('flex mb-2', i % 2 === 0 ? 'justify-end' : 'justify-start')}>
                <div className={cn(
                  'max-w-[70%] rounded-lg px-3 py-2 shadow-sm',
                  i % 2 === 0 ? 'rounded-br-none' : 'rounded-bl-none'
                )}>
                  <Skeleton className="h-4 mb-2" style={{ width: `${Math.random() * 150 + 150}px` }} />
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      "flex-1 flex flex-col bg-chat-bg",
      !isVisible && "hidden md:flex"
    )}>
      <div className="p-3 border-b border-line bg-panel">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {onBack && (
              <Button
                onClick={onBack}
                variant="ghost"
                size="icon"
                className="md:hidden text-muted-fg hover:bg-panel flex-shrink-0"
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
            )}
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-medium text-fg truncate">{contactName || (username ? `@${username}` : phoneNumber) || 'Conversation'}</h2>
              {contactName && username && (
                <p className="text-xs text-muted-fg truncate">@{username}</p>
              )}
              {contactName && !username && phoneNumber && (
                <p className="text-xs text-muted-fg truncate">{phoneNumber}</p>
              )}
            </div>
          </div>
          <Button
            onClick={handleRefresh}
            disabled={refreshing}
            variant="ghost"
            size="icon"
            className="text-muted-fg hover:bg-panel"
          >
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
          </Button>
        </div>
        <AssignmentBar assignment={assignment} me={me} busy={assignBusy} onAction={assignAction} />
      </div>

      <div className="relative flex-1 h-0 flex flex-col">
      <div className="chat-watermark" aria-hidden="true" />
      <ScrollArea ref={messagesContainerRef} className="relative flex-1 h-0 p-4">
        <div className="max-w-[900px] mx-auto">
        {messages.length === 0 ? (
          <p className="text-center text-muted-foreground">No messages yet</p>
        ) : (
          messages.map((message, index) => {
            const prevMessage = index > 0 ? messages[index - 1] : null;
            const showDateDivider = shouldShowDateDivider(message, prevMessage);

            return (
              <div key={message.id}>
                {showDateDivider && (
                  <div className="flex justify-center my-4">
                    <Badge variant="secondary" className="shadow-sm">
                      {formatDateDivider(message.createdAt)}
                    </Badge>
                  </div>
                )}

                <div
                  className={cn(
                    'flex mb-2',
                    message.direction === 'outbound' ? 'justify-end' : 'justify-start'
                  )}
                >
                  <div
                    className={cn(
                      'max-w-[70%] rounded-lg relative',
                      message.messageType === 'sticker'
                        ? 'bg-transparent px-1 py-1'
                        : message.direction === 'outbound'
                          ? 'bg-bubble-out text-fg rounded-br-none px-3 py-2 shadow-sm'
                          : 'bg-surface text-fg rounded-bl-none px-3 py-2 shadow-sm'
                    )}
                  >
                    {(() => {
                      const src = message.mediaData?.url || (message.metadata?.mediaId ? `/api/media/${encodeURIComponent(message.metadata.mediaId)}` : undefined);
                      if (!message.hasMedia && !src) return null;
                      const mime = message.mediaData?.contentType || message.mimeType;
                      return (
                        <div className={cn(message.messageType !== 'sticker' && 'mb-1')}>
                          <MediaMessage
                            src={src}
                            kind={mediaKindFrom(message.messageType, mime)}
                            filename={message.mediaData?.filename || message.filename}
                            mimeType={mime}
                            sizeText={message.mediaData?.sizeText}
                            onOpenImage={(url) => openViewer(url)}
                          />
                        </div>
                      );
                    })()}

                    {message.caption && (
                      <p className="text-sm break-words whitespace-pre-wrap mb-1">
                        {message.caption}
                      </p>
                    )}

                    {message.content && message.content !== '[Image attached]' && message.content !== message.caption && (
                      <p className="text-sm break-words whitespace-pre-wrap">
                        {message.content}
                      </p>
                    )}

                    <div className="flex items-center gap-1.5 mt-1">
                      {message.direction === 'outbound' && message.senderName && (
                        <span className="text-[11px] text-muted-fg">
                          Enviado por {message.senderName} ·
                        </span>
                      )}
                      <span className="text-[11px] text-muted-fg">
                        {formatMessageTime(message.createdAt)}
                      </span>


                      {message.direction === 'outbound' && <StatusIcon status={message.status} />}
                    </div>

                    {message.direction === 'outbound' && message.status === 'failed' && (
                      <div className="mt-1">
                        <span className="text-[11px] text-red-500 flex items-center gap-1">
                          No enviado
                        </span>
                      </div>
                    )}

                    {message.reactionEmoji && (
                      <div className="absolute -bottom-2 -right-2 bg-background rounded-full px-1.5 py-0.5 text-sm shadow-sm border">
                        {message.reactionEmoji}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
        {visiblePending.map((p) => (
          <div key={p.localId} className="flex mb-2 justify-end animate-bubble-in">
            <div className="max-w-[70%] rounded-lg px-3 py-2 relative shadow-sm bg-bubble-out text-fg rounded-br-none">
              {p.file && (
                <div className="mb-1">
                  <MediaMessage
                    src={p.previewUrl}
                    kind={mediaKindFrom(undefined, p.file.type)}
                    filename={p.file.name}
                    mimeType={p.file.type}
                    sizeText={formatBytes(p.file.size)}
                    onOpenImage={(url) => openViewer(url)}
                  />
                </div>
              )}
              {p.content && <p className="text-sm break-words whitespace-pre-wrap">{p.content}</p>}
              <div className="flex items-center gap-1.5 mt-1">
                {myName && <span className="text-[11px] text-muted-fg">Enviado por {myName} ·</span>}
                <span className="text-[11px] text-muted-fg">{formatMessageTime(p.createdAt)}</span>
                <StatusIcon status={p.status} />
              </div>
              {p.status === 'failed' && (
                <div className="mt-1 flex items-center gap-2" role="alert">
                  <span className="text-[11px] text-red-600 dark:text-red-400">No enviado</span>
                  <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={inFlightRef.current.has(p.localId)} onClick={(e) => { e.currentTarget.disabled = true; retryPending(p); }}>
                    Reintentar
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
        </div>
      </ScrollArea>
      </div>

      <div className="border-t border-line bg-panel">
        {canSendRegularMessage ? (
          <>
            {selectedFile && (
              <div className="p-3 border-b border-line bg-surface">
                <div className="flex items-start gap-3">
                  {filePreview ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={filePreview} alt="Preview" className="w-16 h-16 object-cover rounded" />
                  ) : (
                    <div className="w-16 h-16 bg-panel rounded flex items-center justify-center">
                      <Paperclip className="h-6 w-6 text-muted-fg" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-fg truncate">{selectedFile.name}</p>
                    <p className="text-xs text-muted-fg">{(selectedFile.size / 1024).toFixed(1)} KB</p>
                  </div>
                  <Button
                    onClick={handleRemoveFile}
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-muted-fg"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            <form onSubmit={handleSendMessage} className="p-3 max-w-[900px] mx-auto w-full flex gap-2 items-center">
              <input
                ref={fileInputRef}
                type="file"
                onChange={handleFileSelect}
                accept="image/*,video/*,audio/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                className="hidden"
              />
              <Button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                              variant="ghost"
                size="icon"
                className="text-muted-fg hover:bg-line/30"
                title="Upload file"
              >
                <Paperclip className="h-5 w-5" />
              </Button>
              <Button
  type="button"
  onClick={() => {
    setMessageInput('➡️MUNDO RADIOLOGICO⬅️⚠️INFORMA⚠️Hemos Recibido la Documentacion Solicitada, Tener en Cuenta que Esta Linea📲es exclusiva,  para verificación de documentos (Orden Medica - Historia Clínica), por este motivo usted No🚫Estará Recibiendo Respuesta o Información por este medio. Si ya✅fue Radicada su Solicitud a Nuestra Linea Pbx ☎️(608)6345997☎️ estar atento a nuestra llamada☎️en los Horarios⌚de atención✅');
  }}
  variant="ghost"
  size="icon"
  className="text-muted-fg hover:bg-line/30"
  title="Mensaje Rapido"
>
  <MessageSquare className="h-5 w-5" />
</Button>
              <Button
                type="button"
                onClick={() => { if (confirmReply()) setShowInteractiveDialog(true); }}
                              size="icon"
                variant="ghost"
                className="text-muted-fg hover:text-brand-text hover:bg-panel"
                title="Enviar mensaje interactivo"
                aria-label="Enviar mensaje interactivo"
              >
                <ListTree className="h-5 w-5" />
              </Button>
              <Input
                type="text"
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                placeholder="Escribe un mensaje"
                aria-label="Escribe un mensaje"
                              className="flex-1 bg-surface border-line focus-visible:ring-brand rounded-lg"
              />
              <Button aria-label="Enviar"
                type="submit"
                disabled={!messageInput.trim() && !selectedFile}
                size="icon"
                className="bg-brand hover:bg-brand-hover rounded-full"
              >
                <Send className="h-5 w-5" />
              </Button>
            </form>
          </>
        ) : (
          <div className="p-3 max-w-[900px] mx-auto w-full">
            <div className="bg-warn-bg border border-warn-line rounded-lg p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-warn-fg flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-fg mb-3">
                    {getDisabledInputMessage(messages)}
                  </p>
                  <Button
                    onClick={() => { if (confirmReply()) setShowTemplateDialog(true); }}
                    className="bg-brand hover:bg-brand-hover"
                    size="sm"
                  >
                    <MessageSquare className="h-4 w-4 mr-2" />
                    Enviar plantilla
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <TemplateSelectorDialog
        open={showTemplateDialog}
        onOpenChange={setShowTemplateDialog}
        phoneNumber={phoneNumber || ''}
        onTemplateSent={handleTemplateSent}
      />

      <InteractiveMessageDialog
        open={showInteractiveDialog}
        onOpenChange={setShowInteractiveDialog}
        conversationId={conversationId}
        phoneNumber={phoneNumber}
        onMessageSent={fetchMessages}
      />

      <ImageViewer
        images={viewerImages}
        index={viewerIndex}
        onIndexChange={setViewerIndex}
        onClose={() => setViewerIndex(null)}
      />
    </div>
  );
}
