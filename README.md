# Next.js Arabic Template

A modern, production-ready Next.js template with full Arabic/RTL support. Built with TypeScript and TailwindCSS for rapid development.

---

## 🚀 Features

### Core Features
- ⚡ **Next.js 16** with App Router for optimal performance
- 🎨 **TailwindCSS** for modern, utility-first styling
- 📝 **TypeScript** for type-safe development
- 🌐 **RTL Support** - Full Arabic language support with proper RTL layout
- 🔤 **Cairo Font** from Google Fonts for beautiful Arabic typography
- ☁️ **Supabase Ready** - Pre-configured for cloud-based content management

### Technical Stack

| Technology | Purpose |
|------------|---------|
| [Next.js 16](https://nextjs.org/) | React framework with App Router |
| [TypeScript](https://www.typescriptlang.org/) | Type-safe JavaScript |
| [TailwindCSS](https://tailwindcss.com/) | Utility-first CSS framework |
| [Supabase](https://supabase.com/) | Backend-as-a-Service (optional) |
| [Google Fonts](https://fonts.google.com/) | Cairo font for Arabic typography |

## 🏗️ Project Structure

```
src/
├── app/
│   ├── layout.tsx          # Root layout with RTL support
│   ├── page.tsx            # Homepage
│   ├── globals.css         # Global styles
│   └── api/                # API routes
├── components/             # Reusable components
├── content/                # Content management
│   └── useContent.ts       # Content hook
├── lib/                    # Utility functions
└── styles/                 # Additional styles
```

## 🚀 Getting Started

### Prerequisites
- Node.js 22.x or higher
- npm, yarn, or pnpm

### Installation

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd <your-project-name>
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   
   Copy the example file and configure your values:
   ```bash
   cp .env.example .env.local
   ```

4. **Run the development server**
   ```bash
   npm run dev
   ```

5. **Open your browser**
   
   Navigate to [http://localhost:3000](http://localhost:3000)

## 🔧 Configuration

### Environment Variables

Copy `.env.example` to `.env.local` and configure:

```bash
# Admin Configuration
ADMIN_PASSWORD=your_admin_password

# Supabase Configuration (optional)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

### Bootstrap The First Admin License Key

Run the one-time bootstrap script to create an initial active license key and automatically append it to `LICENSE_ADMIN_KEYS` in `.env.local`.

```bash
npm run license:bootstrap
```

When passing flags, use an extra argument separator so npm forwards options correctly:

```bash
npm run license:bootstrap -- -- --force --valid-until 2027-01-01T00:00:00Z --redact-key
```

Optional flags:

- `--days 365` sets validity duration in days.
- `--valid-until 2027-01-01T00:00:00Z` sets an exact expiry date/time.
- `--name "Primary Admin" --email "admin@example.com" --phone "..."`
- `--notes "Initial bootstrap key"`
- `--force` allows adding another admin key when one already exists in `LICENSE_ADMIN_KEYS`.
- `--no-env-update` creates the key without editing `.env.local`.
- `--env-file .env.local` chooses a different env file path.
- `--redact-key` masks the printed key in terminal output.

### Customization

1. Update `src/app/layout.tsx` with your app title and description
2. Modify `tailwind.config.ts` to customize your design tokens
3. Add your components to `src/components/`
4. Configure your content in `src/content/`

## 📱 RTL Support

This template is fully configured for RTL (Right-to-Left) languages:

- HTML `dir="rtl"` and `lang="ar"` set in layout
- TailwindCSS RTL plugin included
- Cairo font optimized for Arabic text

## 🚢 Deployment

### Deploy to Vercel

1. Push to GitHub
2. Import to Vercel
3. Add environment variables
4. Deploy!

### Environment Variables Required

See `.env.example` for complete documentation.

## 📄 License

MIT License - Feel free to use this template for your projects.

---

**Built for the Arabic-speaking community** 🌍