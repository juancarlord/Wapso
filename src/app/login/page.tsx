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
    <div className="min-h-screen flex items-center justify-center bg-[#f0f2f5] p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-white rounded-lg shadow-sm border border-[#d1d7db] p-6 space-y-4">
        <h1 className="text-xl font-semibold text-[#111b21] text-center">Iniciar sesión</h1>
        <div className="space-y-2">
          <Label htmlFor="username">Usuario</Label>
          <Input id="username" autoComplete="username" autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Contraseña</Label>
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <Button type="submit" disabled={loading} className="w-full bg-[#00a884] hover:bg-[#008f72] text-white">
          {loading ? 'Ingresando…' : 'Ingresar'}
        </Button>
      </form>
    </div>
  );
}
