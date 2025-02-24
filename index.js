const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const moment = require('moment-timezone'); // Add moment-timezone for better date handling

dotenv.config();

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// Set up rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later' }
});

app.use('/api/', apiLimiter);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('Connected to MongoDB');
}).catch((err) => {
  console.error('MongoDB connection error:', err);
});

// Define Schema
const ReminderSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    trim: true,
    match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  },
  problemUrl: {
    type: String,
    required: true,
    trim: true
  },
  problemTitle: {
    type: String,
    trim: true
  },
  scheduledFor: {
    type: Date,
    required: true
  },
  timezone: {  // Store the user's timezone
    type: String,
    default: 'UTC'
  },
  sent: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const Reminder = mongoose.model('Reminder', ReminderSchema);

// Set up email transporter
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: 587,
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

// Default timezone (use America/New_York if not specified)
const DEFAULT_TIMEZONE =  'Asia/Kolkata';

// Email templates
const emailTemplates = {
  confirmation: (problemTitle, problemUrl, scheduledTime) => ({
    subject: 'LeetCode Reminder Confirmation',
    html: `
      <h2>Your LeetCode Reminder has been set!</h2>
      <p>Problem: ${problemTitle || 'LeetCode Problem'}</p>
      <p>URL: <a href="${problemUrl}">${problemUrl}</a></p>
      <p>You will be reminded on: ${scheduledTime}</p>
      <p>Keep coding!</p>
    `
  }),
  
  reminder: (problemTitle, problemUrl) => ({
    subject: 'Time to Review Your LeetCode Problem!',
    html: `
      <h2>Time to review your LeetCode problem!</h2>
      <p>Problem: ${problemTitle || 'LeetCode Problem'}</p>
      <p>URL: <a href="${problemUrl}">${problemUrl}</a></p>
      <p>Happy coding!</p>
    `
  })
};

// Helper functions
const validateEmail = (email) => {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
};

const parseReminderTime = (reminderMinutes) => {
  // Handle number input directly
  if (typeof reminderMinutes === 'number') {
    return reminderMinutes > 0 ? Math.floor(reminderMinutes) : null;
  }
  
  // Handle string input
  if (typeof reminderMinutes !== 'string') {
    return null;
  }
  
  // Remove whitespace and convert to lowercase
  const timeStr = reminderMinutes.trim().toLowerCase();
  
  // Parse time with unit
  if (timeStr.endsWith('m') || timeStr.endsWith('h') || timeStr.endsWith('d')) {
    const value = parseInt(timeStr);
    if (isNaN(value) || value <= 0) {
      return null;
    }
    
    if (timeStr.endsWith('m')) {
      return value; // minutes
    } else if (timeStr.endsWith('h')) {
      return value * 60; // hours to minutes
    } else if (timeStr.endsWith('d')) {
      return value * 24 * 60; // days to minutes
    }
  }
  
  // Handle plain number string
  const value = parseInt(timeStr);
  return (!isNaN(value) && value > 0) ? value : null;
};

const calculateReminderTime = (minutes, timezone = DEFAULT_TIMEZONE) => {
  // Use moment-timezone to properly handle time calculations with timezone
  return moment().tz(timezone).add(minutes, 'minutes').toDate();
};

const formatScheduledTime = (date, timezone = DEFAULT_TIMEZONE) => {
  // Format date with proper timezone
  return moment(date).tz(timezone).format('MMM D, YYYY h:mm A z');
};

// Detect timezone from request if possible
const detectTimezone = (req) => {
  // Try to get timezone from headers
  const timezone = req.headers['x-timezone'] || DEFAULT_TIMEZONE;
  
  // Validate timezone - if invalid, fall back to default
  return moment.tz.zone(timezone) ? timezone : DEFAULT_TIMEZONE;
};

// Send email with error handling
const sendEmail = async (to, template) => {
  try {
    const mailOptions = {
      from: process.env.MAIL_USER,
      to,
      subject: template.subject,
      html: template.html
    };
    
    await transporter.sendMail(mailOptions);
    return { success: true };
  } catch (error) {
    console.error('Error sending email:', error);
    return { 
      success: false, 
      error: `Failed to send email: ${error.message}`
    };
  }
};

// API Routes
app.post('/api/set-reminder', async (req, res) => {
  const { email, problemUrl, problemTitle, reminderMinutes, timezone: userTimezone } = req.body;

  try {
    // Input validation
    if (!email || !problemUrl || reminderMinutes === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Parse and validate reminder time
    const minutes = parseReminderTime(reminderMinutes);
    
    if (minutes === null) {
      return res.status(400).json({ 
        error: 'Invalid reminder time. Please provide a positive whole number' 
      });
    }

    // Use provided timezone or detect from headers or use default
    const timezone = userTimezone || detectTimezone(req);
    
    // Calculate scheduled time in the correct timezone
    const scheduledFor = calculateReminderTime(minutes, timezone);
    const formattedScheduledTime = formatScheduledTime(scheduledFor, timezone);

    // Create reminder in database first
    const reminder = new Reminder({
      email,
      problemUrl,
      problemTitle,
      scheduledFor,
      timezone, // Store the timezone for later use
    });

    await reminder.save();
    
    // Then send confirmation email
    const emailResult = await sendEmail(
      email, 
      emailTemplates.confirmation(problemTitle, problemUrl, formattedScheduledTime)
    );
    
    // If email fails, still return success but note the email issue
    if (!emailResult.success) {
      return res.status(207).json({
        success: true,
        message: 'Reminder set successfully but confirmation email failed to send',
        scheduledFor: formattedScheduledTime,
        timezone: timezone,
        emailError: emailResult.error
      });
    }

    res.json({
      success: true,
      message: 'Reminder set successfully',
      scheduledFor: formattedScheduledTime,
      timezone: timezone
    });
    
  } catch (error) {
    console.error('Error setting reminder:', error);
    res.status(500).json({ error: 'Failed to set reminder. Please try again later.' });
  }
});

// Use environment variable for cron secret
const CRON_SECRET = process.env.CRON_SECRET || crypto.randomBytes(32).toString('hex');
console.log('CRON_SECRET (for setup purposes):', CRON_SECRET);

app.post('/api/check-reminders', async (req, res) => {
  // Verify secret from environment variable
  if (req.headers['x-cron-secret'] !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const dueReminders = await Reminder.find({
      scheduledFor: { $lte: new Date() },
      sent: false,
    });

    const results = [];

    for (const reminder of dueReminders) {
      // Send reminder email
      const emailResult = await sendEmail(
        reminder.email,
        emailTemplates.reminder(reminder.problemTitle, reminder.problemUrl)
      );
      
      // Mark as sent even if email failed (to prevent retry spam)
      reminder.sent = true;
      await reminder.save();
      
      results.push({
        reminderId: reminder._id,
        email: reminder.email,
        scheduledFor: formatScheduledTime(reminder.scheduledFor, reminder.timezone),
        emailSent: emailResult.success,
        error: emailResult.success ? null : emailResult.error
      });
    }

    res.json({ 
      success: true, 
      processedReminders: dueReminders.length,
      results
    });
  } catch (error) {
    console.error('Error processing reminders:', error);
    res.status(500).json({ error: 'Failed to process reminders' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.2' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});