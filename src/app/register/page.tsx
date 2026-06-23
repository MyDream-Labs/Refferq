import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';

import { RegisterPageClient } from './register-page-client';

type SearchParamValue = string | string[] | undefined;

type RegisterPageProps = {
  searchParams?: {
    email?: SearchParamValue;
  };
};

function resolveEmailParam(value: SearchParamValue): string {
  if (Array.isArray(value)) {
    return value[0] || '';
  }
  return value || '';
}

export default function RegisterPage({ searchParams }: RegisterPageProps) {
  const initialEmail = resolveEmailParam(searchParams?.email);

  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-muted/30 to-background p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Loading...</span>
          </div>
        </div>
      }
    >
      <RegisterPageClient initialEmail={initialEmail} />
    </Suspense>
  );
}
