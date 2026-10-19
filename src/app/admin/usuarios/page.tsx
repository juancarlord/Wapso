'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';

type Role = 'admin' | 'lead' | 'agent';
const ROLE_LABELS: Record<Role, string> = { admin: 'Administrador', lead: 'Líder', agent: 'Agente' };

type User = {
  id: number; username: string; name: string; role: Role; active: number;
  must_change_password: number; created_at: string; last_login_at?: string | null;
};

export default function UsersAdminPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [me, setMe] = useState<number | null>(null);
  const [myRole, setMyRole] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ username: '', name: '', password: '', role: 'agent' });

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/users');
    if (!res.ok) { setError('No se pudo cargar la lista de usuarios'); return; }
    const data = await res.json();
    setUsers(data.users); setMe(data.me); setMyRole(data.myRole);
  }, []);
  useEffect(() => { load(); }, [load]);

  const call = async (url: string, method: string, body: unknown, ok: string) => {
    setError(null); setNotice(null);
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setError(data?.error || 'Ocurrió un error'); return false; }
    setNotice(ok); await load(); return true;
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (await call('/api/admin/users', 'POST', form, `Usuario ${form.username} creado. Deberá cambiar la contraseña al entrar.`)) {
      setForm({ username: '', name: '', password: '', role: 'agent' });
    }
  };
  const act = (u: User, action: string, extra: Record<string, string> = {}, msg = 'Cambios guardados') =>
    call(`/api/admin/users/${u.id}`, 'PATCH', { action, ...extra }, msg);
  const reset = (u: User) => {
    const pw = window.prompt(`Nueva contraseña temporal para ${u.username} (mínimo 10 caracteres):`);
    if (pw) act(u, 'reset_password', { password: pw }, `Contraseña de ${u.username} restablecida`);
  };

  const canWrite = myRole === 'admin' || myRole === 'lead';
  const canManage = (u: User) => myRole === 'admin' || (myRole === 'lead' && u.role === 'agent');
  const remove = (u: User) => {
    if (window.confirm(`¿Eliminar a ${u.name}? Esta acción no se puede deshacer.`)) {
      call(`/api/admin/users/${u.id}`, 'DELETE', {}, `${u.username} eliminado`);
    }
  };

  const fmt = (d: string | null) => (d ? new Date(d.replace(' ', 'T') + 'Z').toLocaleString('es-CO') : '—');

  return (
    <div className="min-h-screen bg-panel p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="icon" aria-label="Volver"><Link href="/"><ArrowLeft className="h-4 w-4" /></Link></Button>
          <h1 className="text-xl font-semibold text-fg">Usuarios</h1>
        </div>

        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {notice && <p className="text-sm text-brand-text">{notice}</p>}

        {canWrite && (
        <form onSubmit={create} className="bg-surface rounded-lg border border-line p-4 grid gap-3 md:grid-cols-5 items-end">
          <div className="space-y-1"><Label htmlFor="u">Usuario</Label>
            <Input id="u" required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="n">Nombre</Label>
            <Input id="n" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="p">Contraseña temporal</Label>
            <Input id="p" type="password" autoComplete="new-password" required minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="r">Rol</Label>
            <select id="r" className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="agent">Agente</option>
              {myRole === 'admin' && <option value="lead">Líder</option>}
              {myRole === 'admin' && <option value="admin">Administrador</option>}
            </select></div>
          <Button type="submit" className="bg-brand hover:bg-brand-hover text-white">Crear usuario</Button>
        </form>
        )}

        <div className="bg-surface rounded-lg border border-line overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-fg border-b border-line">
              <tr><th className="p-3">Usuario</th><th className="p-3">Nombre</th><th className="p-3">Rol</th><th className="p-3">Estado</th>{canWrite && <th className="p-3">Último ingreso</th>}{canWrite && <th className="p-3">Acciones</th>}</tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u.id === me;
                return (
                  <tr key={u.id} className="border-b border-panel last:border-0">
                    <td className="p-3 font-medium">{u.username}{self && ' (tú)'}</td>
                    <td className="p-3">{u.name}</td>
                    <td className="p-3">{ROLE_LABELS[u.role] ?? u.role}</td>
                    <td className="p-3">{u.active ? <Badge variant="secondary">Activo</Badge> : <Badge variant="outline">Inactivo</Badge>}
                      {u.must_change_password ? <span className="ml-1 text-xs text-muted-fg">debe cambiar contraseña</span> : null}</td>
                    {canWrite && <td className="p-3 text-muted-fg">{fmt(u.last_login_at ?? null)}</td>}
                    {canWrite && (
                    <td className="p-3 flex flex-wrap gap-1">
                      {!self && canManage(u) && <Button size="sm" variant="outline" onClick={() => reset(u)}>Restablecer contraseña</Button>}
                      {!self && myRole === 'admin' && (
                        <select aria-label={`Rol de ${u.username}`} className="h-8 rounded-md border border-input bg-transparent px-2 text-sm" value={u.role}
                          onChange={(e) => act(u, 'set_role', { role: e.target.value }, `Rol de ${u.username} actualizado`)}>
                          <option value="agent">Agente</option><option value="lead">Líder</option><option value="admin">Administrador</option>
                        </select>
                      )}
                      {!self && canManage(u) && (u.active
                        ? <Button size="sm" variant="outline" className="text-red-600" onClick={() => window.confirm(`¿Desactivar a ${u.username}?`) && act(u, 'deactivate', {}, `${u.username} desactivado`)}>Desactivar</Button>
                        : <Button size="sm" variant="outline" onClick={() => act(u, 'reactivate', {}, `${u.username} reactivado`)}>Reactivar</Button>)}
                      {!self && canManage(u) && <Button size="sm" variant="outline" className="text-red-600" onClick={() => remove(u)}>Eliminar</Button>}
                    </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
