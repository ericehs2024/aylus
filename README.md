# Aylus - Volunteer Hours Tracker

A modern, user-friendly web application for tracking volunteer hours, managing events, and generating reports.

I lead a branch of AYLUS, a nationwide student‑run nonprofit with more than 180 branches. One of my responsibilities is compiling each member’s monthly and yearly volunteer hours—a process that is accurate but extremely time‑consuming. To make this easier, I built a small tool called Volunteer Auto Logger.

All AYLUS branches are welcome to download the tool and use it on their local devices. I hope it helps save your time and energy as well.

## Features

- **Volunteer Management**: Track volunteer information and history.
- **Event Management**: Create, manage, and track attendance for volunteer events.
- **Hours Tracking**: Log and verify volunteer hours with detailed records.
- **Reporting**: Generate comprehensive reports on volunteer activities and hours.
- **User Authentication**: Secure login system for volunteers and administrators.
- **Responsive Design**: Works seamlessly on desktop and mobile devices.

## Tech Stack

- **Frontend**: React, Vite, Tailwind CSS
- **Backend**: Node.js, Express
- **Database**: MongoDB
- **Authentication**: JWT (JSON Web Tokens)

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- MongoDB

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd aylus
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   Create a `.env` file in the root directory with the following variables:
   ```env
   PORT=5000
   MONGO_URI=your_mongodb_connection_string
   JWT_SECRET=your_jwt_secret
   ```

4. Start the development server:
   ```bash
   npm run dev
   ```

## Usage

### Development

The application runs on `http://localhost:5000` by default.

### Build

To create a production build:
```bash
npm run build
```

### Production

To run the production build:
```bash
npm run start
```

## Project Structure

```
aylus/
├── client/          # React frontend
├── server/          # Node.js/Express backend
├── .env             # Environment variables
├── package.json     # Project dependencies
└── README.md        # Project documentation
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

ISC
