const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('Connected to MongoDB');
}).catch((err) => {
  console.error('MongoDB connection error:', err);
});

const ReminderSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true
  },
  problemUrl: {
    type: String,
    required: true
  },
  problemTitle: String,
  scheduledFor: {
    type: Date,
    required: true
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

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: 587,
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

const parseReminderTime = (timeStr) => {
  // If it's already a number, return it
  if (typeof timeStr === 'number') {
    return timeStr;
  }

  // Convert string to string type if it's not already
  timeStr = String(timeStr);

  // Remove any whitespace
  timeStr = timeStr.trim();

  // Parse the numeric part
  const value = parseInt(timeStr);

  // If we can't parse a number, return null
  if (isNaN(value)) {
    return null;
  }

  // If there's a unit suffix, convert accordingly
  if (timeStr.endsWith('m')) {
    return value; // minutes
  } else if (timeStr.endsWith('h')) {
    return value * 60; // convert hours to minutes
  } else if (timeStr.endsWith('d')) {
    return value * 24 * 60; // convert days to minutes
  }

  // If no suffix, assume minutes
  return value;
};

const calculateReminderTime = (minutes) => {
  const now = new Date();
  return new Date(now.getTime() + (minutes * 60 * 1000));
};

app.post('/api/set-reminder', async (req, res) => {
  const { email, problemUrl, problemTitle, reminderMinutes } = req.body;

  try {
    // Input validation
    if (!email || !problemUrl || !reminderMinutes) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Parse the reminder time
    const minutes = parseReminderTime(reminderMinutes);
    
    if (minutes === null || minutes <= 0) {
      return res.status(400).json({ 
        error: 'Invalid reminder time. Please provide a positive number followed by optional m/h/d suffix (e.g., "30m", "2h", "1d")' 
      });
    }

    const scheduledFor = calculateReminderTime(minutes);
    
    // Format for display
    const formattedScheduledTime = scheduledFor.toLocaleString('en-US', {
      dateStyle: 'short',
      timeStyle: 'short'
    });

    // Send confirmation email
    const confirmationMail = {
      from: process.env.MAIL_USER,
      to: email,
      subject: 'LeetCode Reminder Confirmation',
      html: `
        <h2>Your LeetCode Reminder has been set!</h2>
        <p>Problem: ${problemTitle || 'LeetCode Problem'}</p>
        <p>URL: <a href="${problemUrl}">${problemUrl}</a></p>
        <p>You will be reminded on: ${formattedScheduledTime}</p>
        <p>Keep coding!</p>
      `,
    };

    await transporter.sendMail(confirmationMail);

    // Store reminder in database
    const reminder = new Reminder({
      email,
      problemUrl,
      problemTitle,
      scheduledFor,
    });

    await reminder.save();

    res.json({
      success: true,
      message: 'Reminder set successfully',
      scheduledFor: formattedScheduledTime
    });
  } catch (error) {
    console.error('Error setting reminder:', error);
    res.status(500).json({ error: 'Failed to set reminder' });
  }
});

app.post('/api/check-reminders', async (req, res) => {
  if (req.headers['x-cron-secret'] !== 'Sanjeev') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const dueReminders = await Reminder.find({
      scheduledFor: { $lte: new Date() },
      sent: false,
    });

    for (const reminder of dueReminders) {
      const mailOptions = {
        from: process.env.MAIL_USER,
        to: reminder.email,
        subject: 'Time to Review Your LeetCode Problem!',
        html: `
          <h2>Time to review your LeetCode problem!</h2>
          <p>Problem: ${reminder.problemTitle || 'LeetCode Problem'}</p>
          <p>URL: <a href="${reminder.problemUrl}">${reminder.problemUrl}</a></p>
          <p>Happy coding!</p>
        `,
      };

      await transporter.sendMail(mailOptions);
      reminder.sent = true;
      await reminder.save();
    }

    res.json({ 
      success: true, 
      processedReminders: dueReminders.length 
    });
  } catch (error) {
    console.error('Error processing reminders:', error);
    res.status(500).json({ error: 'Failed to process reminders' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});