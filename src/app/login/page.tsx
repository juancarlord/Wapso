'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        window.location.href = data?.mustChangePassword ? '/cambiar-contrasena' : '/';
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data?.error || 'Usuario o contraseña incorrectos');
    } catch {
      setError('No se pudo conectar. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center gap-4 bg-panel p-4">
      <span className="pointer-events-none select-none absolute bottom-3 right-4 text-xs text-muted-foreground opacity-50">Powered by TKB</span>
      <div className="flex flex-col items-center gap-2">
        <div className="rounded-2xl p-2 dark:bg-white dark:shadow-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="Mundo Radiológico" width={140} height={139} className="w-[140px] h-auto" />
        </div>
        <p className="text-sm font-semibold tracking-wide text-brand-strong dark:text-brand-text">Contact Center Mundo Radiológico</p>
      </div>
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-surface rounded-lg shadow-sm border border-line p-6 space-y-4">
        <h1 className="text-xl font-semibold text-fg text-center">Iniciar sesión</h1>
        <div className="space-y-2">
          <Label htmlFor="username">Usuario</Label>
          <Input id="username" autoComplete="username" autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Contraseña</Label>
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <Button type="submit" disabled={loading} className="w-full bg-brand hover:bg-brand-hover text-white">
          {loading ? 'Ingresando…' : 'Ingresar'}
        </Button>
      </form>
    </div>
  );
}
