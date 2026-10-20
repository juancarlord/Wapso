'use client';

import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { CheckCircle2, RotateCcw, UserPlus, UserMinus, ArrowRightLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type ChatAssignment = {
  key: string;
  assignedUserId: number | null;
  assignedName: string | null;
  status: 'open' | 'resolved';
  resolvedByName: string | null;
  resolvedAt: number | null;
};
export type Me = { id: number; role: 'admin' | 'lead' | 'agent' };
type UserOpt = { id: number; name: string };

type Props = {
  assignment: ChatAssignment | null;
  me: Me | null;
  busy: boolean;
  onAction: (action: 'take' | 'release' | 'transfer' | 'resolve' | 'reopen', userId?: number) => void;
};

export function AssignmentBar({ assignment: a, me, busy, onAction }: Props) {
  const [users, setUsers] = useState<UserOpt[]>([]);
  const [transferring, setTransferring] = useState(false);
  useEffect(() => {
    if (!transferring || users.length) return;
    fetch('/api/users/active').then((r) => (r.ok ? r.json() : null)).then((j) => setUsers(j?.users ?? [])).catch(() => {});
  }, [transferring, users.length]);

  if (!a || !me) return null;
  const isManager = me.role === 'admin' || me.role === 'lead';
  const unassigned = a.assignedUserId == null;
  const isMine = a.assignedUserId === me.id;
  const canTake = !isMine && (unassigned || isManager);
  const canRelease = !unassigned && (isMine || isManager);
  const canTransfer = (isMine || isManager);
  const canResolve = unassigned || isMine || isManager;
  const resolved = a.status === 'resolved';

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span className={unassigned ? 'text-muted-fg italic' : 'text-brand-text font-medium'}>
        {unassigned ? 'Sin asignar' : isMine ? 'Asignado a ti' : `Asignado a ${a.assignedName ?? 'Usuario eliminado'}`}
      </span>
      {resolved && a.resolvedAt && (
        <span className="rounded-full border border-line px-2 py-0.5 text-muted-fg">
          Resuelto por {a.resolvedByName ?? 'Usuario eliminado'}, {format(new Date(a.resolvedAt), "d MMM h:mm a", { locale: es })}
        </span>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-1">
        {canTake && (
          <Button size="sm" disabled={busy} onClick={() => onAction('take')} className="h-7 bg-brand hover:bg-brand-hover text-white">
            <UserPlus className="h-3.5 w-3.5 mr-1" />{unassigned ? 'Tomar' : 'Reasignarme'}
          </Button>
        )}
        {canRelease && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('release')} className="h-7 text-muted-fg hover:bg-line/30">
            <UserMinus className="h-3.5 w-3.5 mr-1" />Liberar
          </Button>
        )}
        {canTransfer && !transferring && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setTransferring(true)} className="h-7 text-muted-fg hover:bg-line/30">
            <ArrowRightLeft className="h-3.5 w-3.5 mr-1" />Transferir
          </Button>
        )}
        {transferring && (
          <select
            autoFocus
            aria-label="Transferir a"
            className="h-7 rounded-md border border-line bg-surface text-fg px-1"
            defaultValue=""
            onChange={(e) => { const id = Number(e.target.value); setTransferring(false); if (id) onAction('transfer', id); }}
            onBlur={() => setTransferring(false)}
          >
            <option value="" disabled>Transferir a…</option>
            {users.filter((u) => u.id !== a.assignedUserId).map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
        )}
        {resolved ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('reopen')} className="h-7 text-brand-text hover:bg-line/30">
            <RotateCcw className="h-3.5 w-3.5 mr-1" />Reabrir
          </Button>
        ) : canResolve && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('resolve')} className="h-7 text-brand-text hover:bg-line/30">
            <CheckCircle2 className="h-3.5 w-3.5 mr-1" />Resolver
          </Button>
        )}
      </div>
    </div>
  );
}
