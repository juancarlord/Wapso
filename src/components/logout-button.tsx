'use client';

import { LogOut, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function LogoutButton() {
  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  };
  const cls = 'text-muted-fg hover:bg-line/30';
  return (
    <>
      <Button asChild variant="ghost" size="icon" title="Usuarios" aria-label="Usuarios" className={cls}>
        <a href="/admin/usuarios"><Users className="h-4 w-4" /></a>
      </Button>
      <Button onClick={logout} variant="ghost" size="icon" title="Cerrar sesión" aria-label="Cerrar sesión" className={cls}>
        <LogOut className="h-4 w-4" />
      </Button>
    </>
  );
}
