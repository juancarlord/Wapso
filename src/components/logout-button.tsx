'use client';

import { useEffect, useState } from 'react';
import { BarChart3, LogOut, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function LogoutButton() {
  // Usuarios link only for admin/lead (server also blocks agents).
  const [canAdmin, setCanAdmin] = useState(false);
  useEffect(() => {
    fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null)).then((me) => setCanAdmin(me?.role === 'admin' || me?.role === 'lead')).catch(() => {});
  }, []);
  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  };
  const cls = 'text-muted-fg hover:bg-line/30';
  return (
    <>
      {canAdmin && (
        <Button asChild variant="ghost" size="icon" title="Usuarios" aria-label="Usuarios" className={cls}>
          <a href="/admin/usuarios"><Users className="h-4 w-4" /></a>
        </Button>
      )}
      {canAdmin && (
        <Button asChild variant="ghost" size="icon" title="Métricas" aria-label="Métricas" className={cls}>
          <a href="/admin/metricas"><BarChart3 className="h-4 w-4" /></a>
        </Button>
      )}
      <Button onClick={logout} variant="ghost" size="icon" title="Cerrar sesión" aria-label="Cerrar sesión" className={cls}>
        <LogOut className="h-4 w-4" />
      </Button>
    </>
  );
}
