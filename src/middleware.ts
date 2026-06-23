import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { prisma } from '@/lib/prisma';
import { getJwtSecret } from '@/lib/auth-config';

const JWT_SECRET = getJwtSecret();

export async function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl;

    // 1. Define protected routes
    const isAuthMeRoute = pathname === '/api/auth/me';
    const isAdminRoute = pathname.startsWith('/api/admin') || pathname.startsWith('/admin');
    const isAffiliateRoute = pathname.startsWith('/api/affiliate') || pathname.startsWith('/affiliate');
    const isProtectedRoute = isAuthMeRoute || isAdminRoute || isAffiliateRoute;

    if (!isProtectedRoute) {
        return NextResponse.next();
    }

    // 2. Get token from cookies
    const token = request.cookies.get('auth-token')?.value;

    if (!token) {
        // If it's an API route, return 401
        if (pathname.startsWith('/api/')) {
            return NextResponse.json(
                { error: 'Authentication required' },
                { status: 401 }
            );
        }
        // If it's a page route, redirect to login
        return NextResponse.redirect(new URL('/login', request.url));
    }

    try {
        // 3. Verify JWT
        const { payload } = await jwtVerify(token, JWT_SECRET, {
            algorithms: ['HS256'],
        });
        const userId = payload.userId as string | undefined;

        if (!userId) {
            if (pathname.startsWith('/api/')) {
                return NextResponse.json(
                    { error: 'Invalid or expired token' },
                    { status: 401 }
                );
            }
            return NextResponse.redirect(new URL('/login', request.url));
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, role: true, status: true },
        });

        if (!user) {
            if (pathname.startsWith('/api/')) {
                return NextResponse.json(
                    { error: 'Invalid or expired token' },
                    { status: 401 }
                );
            }
            return NextResponse.redirect(new URL('/login', request.url));
        }

        if (user.status !== 'ACTIVE') {
            if (pathname.startsWith('/api/')) {
                return NextResponse.json(
                    { error: 'Account is inactive or pending approval' },
                    { status: 403 }
                );
            }
            return NextResponse.redirect(new URL('/login', request.url));
        }

        const userRole = user.role as string;

        // 4. Role-based access control
        if (isAdminRoute && userRole !== 'ADMIN') {
            if (pathname.startsWith('/api/')) {
                return NextResponse.json(
                    { error: 'Forbidden: Admin access required' },
                    { status: 403 }
                );
            }
            return NextResponse.redirect(new URL('/login', request.url));
        }

        if (isAffiliateRoute && userRole !== 'AFFILIATE' && userRole !== 'ADMIN') {
            if (pathname.startsWith('/api/')) {
                return NextResponse.json(
                    { error: 'Forbidden: Affiliate access required' },
                    { status: 403 }
                );
            }
            return NextResponse.redirect(new URL('/login', request.url));
        }

        // 5. Inject user info into request headers for API usage
        const requestHeaders = new Headers(request.headers);
        requestHeaders.set('x-user-id', user.id);
        requestHeaders.set('x-user-role', userRole);
        requestHeaders.set('x-user-status', user.status);

        return NextResponse.next({
            request: {
                headers: requestHeaders,
            },
        });
    } catch (error) {
        if (pathname.startsWith('/api/')) {
            return NextResponse.json(
                { error: 'Invalid or expired token' },
                { status: 401 }
            );
        }
        return NextResponse.redirect(new URL('/login', request.url));
    }
}

// See "Matching Paths" below to learn more
export const config = {
    matcher: [
        '/admin/:path*',
        '/affiliate/:path*',
        '/api/admin/:path*',
        '/api/affiliate/:path*',
        '/api/auth/me',
    ],
};
