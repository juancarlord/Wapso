'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function ChangePasswordPage() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next.length < 10) return setError('La nueva contraseña debe tener al menos 10 caracteres');
    if (next !== confirm) return setError('Las contraseñas no coinciden');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (res.ok) { window.location.href = '/'; return; }
      const data = await res.json().catch(() => ({}));
      setError(data?.error || 'No se pudo cambiar la contraseña');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f0f2f5] p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-white rounded-lg shadow-sm border border-[#d1d7db] p-6 space-y-4">
        <h1 className="text-xl font-semibold text-[#111b21] text-center">Cambiar contraseña</h1>
        <p className="text-sm text-[#667781] text-center">Elige una contraseña nueva de al menos 10 caracteres.</p>
        <div className="space-y-2">
          <Label htmlFor="current">Contraseña actual</Label>
          <Input id="current" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="next">Nueva contraseña</Label>
          <Input id="next" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">Repite la nueva contraseña</Label>
          <Input id="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <Button type="submit" disabled={loading} className="w-full bg-[#00a884] hover:bg-[#008f72] text-white">
          {loading ? 'Guardando…' : 'Guardar'}
        </Button>
      </form>
    </div>
  );
}
