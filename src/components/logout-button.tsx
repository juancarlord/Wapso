'use client';

import { useEffect, useState } from 'react';
import { LogOut, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function LogoutButton() {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null)).then((me) => setIsAdmin(me?.role === 'admin')).catch(() => {});
  }, []);
  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  };
  const cls = 'text-[#667781] hover:bg-[#d1d7db]/30';
  return (
    <>
      {isAdmin && (
        <Button asChild variant="ghost" size="icon" title="Usuarios" aria-label="Usuarios" className={cls}>
          <a href="/admin/usuarios"><Users className="h-4 w-4" /></a>
        </Button>
      )}
      <Button onClick={logout} variant="ghost" size="icon" title="Cerrar sesión" aria-label="Cerrar sesión" className={cls}>
        <LogOut className="h-4 w-4" />
      </Button>
    </>
  );
}
