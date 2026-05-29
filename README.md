# 🍍 Fruitopia — Multi-Device E-Commerce Store

A real-time, Firebase-powered e-commerce storefront with a full admin panel. Built with **React + Vite + TypeScript + Firebase**.

## ✨ Features

- **Real-time sync** — Change currency, logo, or products from any device, and all visitors see it instantly
- **Multi-device admin** — Log in from any phone, tablet, or computer to manage your store
- **Image uploads** — Products and logos upload to Firebase Storage; no data URLs in Firestore
- **Full CRUD** — Products, categories, coupons, orders, and site settings
- **Admin dashboard** — Real-time order notifications, customizable branding
- **Cart & checkout** — Fully functional shopping cart with order placement
- **Responsive design** — Works on desktop, tablet, and mobile

## 🚀 Quick Start

```bash
npm install
npm run dev
```

Then visit **http://localhost:5173** to see the storefront and **http://localhost:5173/install** to run the setup wizard.

## 📖 Complete Installation Guide

For **step-by-step instructions** covering everything from creating a Firebase project to deploying your live store, see:

👉 **[SETUP.md](./SETUP.md)**

The guide walks you through:

1. Creating a Firebase project
2. Setting up Firestore, Auth, and Storage
3. Running the 7-step Install Wizard
4. Deploying security rules and CORS config
5. Deploying to Vercel, Netlify, cPanel, or a VPS
6. Multi-device sync with `.env`

## 🏗 Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19, TypeScript, Vite |
| **Backend** | Firebase (Firestore, Auth, Storage) |
| **State** | React Context + `onSnapshot()` real-time listeners |
| **Hosting** | Vercel, Netlify, cPanel, or any static host |
| **Styling** | CSS (custom, responsive) |

## 📁 Project Structure

```
src/
├── main.tsx            # App entry point
├── App.tsx             # Root component (boot check → install or store)
├── firebase.ts         # Firebase initialization (4-priority boot chain)
├── firebaseService.ts  # Service layer (settings, uploads)
├── db.ts               # Polymorphic data layer
├── supabase.ts         # Supabase adapter (alternative backend)
├── types.ts            # Shared TypeScript types
├── context/
│   └── AppContext.tsx   # Global state with real-time listeners
├── components/
│   ├── AdminPanel.tsx   # Full admin dashboard
│   ├── CartModal.tsx    # Shopping cart
│   ├── FavoritesMenu.tsx
│   ├── Hero.tsx         # Storefront hero banner
│   ├── Navbar.tsx       # Navigation with cart badge
│   ├── Footer.tsx       # Dynamic footer with social links
│   ├── InstallWizard.tsx # 7-step setup wizard
│   ├── OrderTrackerPage.tsx
│   ├── Newsletter.tsx   # Email signup
│   ├── UserAuthModal.tsx
│   ├── PaymentLogos.tsx
│   ├── Toast.tsx
│   └── Testimonial.tsx
```

## 🔐 Boot Priority Chain

Firebase configuration is resolved in this order (first valid wins):

1. **`/firebase-config.json`** — server-side file (cPanel/PHP deployments)
2. **`VITE_FIREBASE_*` env vars** — baked into the build for multi-device access
3. **`localStorage`** — per-browser config from Install Wizard
4. **`firebase-applet-config.json`** — local development fallback

## 📄 License

See [metadata.json](./metadata.json) for project details.
