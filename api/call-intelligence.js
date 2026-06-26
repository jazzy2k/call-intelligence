// ============================================================
// DIRECT FINANCE — CALL INTELLIGENCE (v5 - Final)
// Vercel Serverless Function: api/call-intelligence.js
// ============================================================

module.exports = async function handler(req, res) {

  if (req.method === "GET") {
    return res.status(200).json({ status: "Call Intelligence is running" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {

    const {
      contact_id,
      contact_name,
      phone,
      call_duration,
      call_direction,
      call_from,
      call_to,
      call_start_time,
      call_id,
      rep_name,
    } = req.body;

    console.log("GHL Webhook received:", { contact_id, contact_name, call_duration, call_direction, call_from, call_to });

    if (parseInt(call_duration) < 10) {
      console.log("Call too short - logging as No Answer");
      if (process.env.MAKE_SHEETS_WEBHOOK_URL) {
        await fetch(process.env.MAKE_SHEETS_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: new Date().toISOString(),
            contact_name: contact_name || "Unknown",
            contact_id: contact_id || "",
            phone: phone || "",
            direction: call_direction === "inbound" ? "Inbound" : "Outbound",
            duration_seconds: call_duration || "0",
            outcome: "No Answer / Too Short",
            reason: "Call ended after " + call_duration + " seconds",
            sentiment: "N/A",
            call_summary: "Call was too short to transcribe",
            next_action: "Try calling again later",
            transcript: "",
            recording_url: "",
            rep_name: rep_name || "",
            call_id: call_id || "",
          }),
        });
      }
      return res.status(200).json({ skipped: "Call too short" });
    }

    // STEP 2: FIND RECORDING IN TWILIO
    console.log("Searching Twilio recordings...");
    var recordingUrl = null;
    var recordingSid = null;

    var twilioAuth = "Basic " + Buffer.from(
      process.env.TWILIO_ACCOUNT_SID + ":" + process.env.TWILIO_AUTH_TOKEN
    ).toString("base64");

    try {
      var today = new Date();
      var dateStr = today.getFullYear() + "-" +
        String(today.getMonth() + 1).padStart(2, "0") + "-" +
        String(today.getDate()).padStart(2, "0");

      var recRes = await fetch(
        "https://api.twilio.com/2010-04-01/Accounts/" + process.env.TWILIO_ACCOUNT_SID + "/Recordings.json?DateCreated=" + dateStr + "&PageSize=50",
        { headers: { Authorization: twilioAuth } }
      );
      var recData = await recRes.json();
      console.log("Recordings found today:", recData.recordings ? recData.recordings.length : 0);

      if (recData.recordings && recData.recordings.length > 0) {
        var targetDur = parseInt(call_duration);
        var matched = recData.recordings.find(function(r) {
          return Math.abs(parseInt(r.duration) - targetDur) <= 5;
        });
        if (!matched) matched = recData.recordings[0];
        if (matched) {
          recordingSid = matched.sid;
          recordingUrl = "https://api.twilio.com/2010-04-01/Accounts/" + process.env.TWILIO_ACCOUNT_SID + "/Recordings/" + recordingSid + ".mp3";
          console.log("Recording matched:", recordingSid);
        }
      }
    } catch (e) {
      console.log("Recording search error:", e.message);
    }

    if (!recordingUrl) {
      console.log("Waiting 8s for recording...");
      await new Promise(function(resolve) { setTimeout(resolve, 8000); });
      try {
        var retryRes = await fetch(
          "https://api.twilio.com/2010-04-01/Accounts/" + process.env.TWILIO_ACCOUNT_SID + "/Recordings.json?PageSize=5",
          { headers: { Authorization: twilioAuth } }
        );
        var retryData = await retryRes.json();
        var latest = retryData.recordings && retryData.recordings[0];
        if (latest) {
          recordingSid = latest.sid;
          recordingUrl = "https://api.twilio.com/2010-04-01/Accounts/" + process.env.TWILIO_ACCOUNT_SID + "/Recordings/" + recordingSid + ".mp3";
          console.log("Recording found on retry:", recordingSid);
        }
      } catch (e) {
        console.log("Retry failed:", e.message);
      }
    }

    // STEP 3: TRANSCRIBE WITH DEEPGRAM
    var transcript = "No recording available for this call";

    if (recordingUrl) {
      console.log("Transcribing with Deepgram...");
      var authUrl = recordingUrl.replace(
        "https://",
        "https://" + process.env.TWILIO_ACCOUNT_SID + ":" + process.env.TWILIO_AUTH_TOKEN + "@"
      );
      try {
        var dgRes = await fetch(
          "https://api.deepgram.com/v1/listen?punctuate=true&diarize=true&language=en&model=nova-2",
          {
            method: "POST",
            headers: {
              Authorization: "Token " + process.env.DEEPGRAM_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ url: authUrl }),
          }
        );
        var dgData = await dgRes.json();
        transcript = (dgData.results &&
          dgData.results.channels &&
          dgData.results.channels[0] &&
          dgData.results.channels[0].alternatives &&
          dgData.results.channels[0].alternatives[0] &&
          dgData.results.channels[0].alternatives[0].transcript) || "Transcript could not be generated";
        console.log("Transcript length:", transcript.length);
      } catch (e) {
        console.log("Deepgram error:", e.message);
      }
    }

    // STEP 4: CLAUDE AI ANALYSIS
    console.log("Sending to Claude...");
    var analysis = {
      outcome: "Needs Review",
      reason: "Could not auto-analyze",
      call_summary: "Manual review required",
      employment: null,
      income: null,
      vehicle: null,
      next_action: "Listen to recording manually",
      sentiment: "Neutral",
      language: "Unknown",
    };

    try {
      var claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 800,
          messages: [{
            role: "user",
            content: "You are a call analyst for Direct Finance, a Canadian subprime auto financing company. Analyze this call transcript and return ONLY raw JSON with these fields: outcome (Qualified|Callback Scheduled|Not Interested|No Answer|Wrong Number|Voicemail Left|Language Barrier|Needs Follow Up|Disconnected), reason, call_summary, employment, income, vehicle, next_action, sentiment (Positive|Neutral|Negative), language.\n\nCall: Direction=" + call_direction + " Duration=" + call_duration + "s Contact=" + (contact_name || "Unknown") + " Rep=" + (rep_name || "Unknown") + "\n\nTranscript:\n" + transcript,
          }],
        }),
      });
      var claudeData = await claudeRes.json();
      var rawText = claudeData.content && claudeData.content[0] && claudeData.content[0].text;
      if (rawText) {
        analysis = JSON.parse(rawText.trim());
      }
    } catch (e) {
      console.log("Claude error:", e.message);
    }

    console.log("Claude result:", analysis.outcome, "|", analysis.sentiment);

    // STEP 5: WRITE NOTE TO GHL
    if (contact_id) {
      var mins = Math.floor(parseInt(call_duration) / 60);
      var secs = parseInt(call_duration) % 60;
      var dur = mins > 0 ? mins + " min " + secs + " sec" : secs + " sec";

      var noteBody = "📞 AI Call Summary — " + new Date().toLocaleDateString("en-CA") + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🎯 Outcome:    " + analysis.outcome + "\n" +
        "😊 Sentiment:  " + analysis.sentiment + "\n" +
        "⏱️ Duration:   " + dur + "\n" +
        "📡 Direction:  " + (call_direction === "inbound" ? "Inbound (lead called us)" : "Outbound (we called lead)") + "\n" +
        "👤 Rep:        " + (rep_name || "Unknown") + "\n" +
        "🌐 Language:   " + (analysis.language || "English") + "\n\n" +
        "📋 Summary:\n" + analysis.call_summary + "\n\n" +
        "💡 Reason:\n" + analysis.reason + "\n\n" +
        "👤 Lead Details:\n" +
        "• Employment: " + (analysis.employment || "Not mentioned") + "\n" +
        "• Income:     " + (analysis.income || "Not mentioned") + "\n" +
        "• Vehicle:    " + (analysis.vehicle || "Not mentioned") + "\n\n" +
        "✅ Next Action:\n" + analysis.next_action + "\n\n" +
        "🎙️ Transcript:\n" + transcript + "\n\n" +
        "🔗 Recording: " + (recordingUrl || "Not available");

      try {
        await fetch(
          "https://services.leadconnectorhq.com/contacts/" + contact_id + "/notes",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + process.env.GHL_API_KEY,
              "Content-Type": "application/json",
              Version: "2021-07-28",
            },
            body: JSON.stringify({ body: noteBody }),
          }
        );
        console.log("Note saved to GHL:", contact_id);
      } catch (e) {
        console.log("GHL note error:", e.message);
      }
    }

    // STEP 6: LOG TO GOOGLE SHEETS
    if (process.env.MAKE_SHEETS_WEBHOOK_URL) {
      try {
        await fetch(process.env.MAKE_SHEETS_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: new Date().toISOString(),
            contact_name: contact_name || "Unknown",
            contact_id: contact_id || "",
            phone: phone || "",
            direction: call_direction === "inbound" ? "Inbound" : "Outbound",
            duration_seconds: call_duration || "0",
            outcome: analysis.outcome,
            reason: analysis.reason,
            sentiment: analysis.sentiment,
            call_summary: analysis.call_summary,
            employment: analysis.employment || "",
            income: analysis.income || "",
            vehicle: analysis.vehicle || "",
            next_action: analysis.next_action,
            language: analysis.language || "English",
            transcript: transcript,
            recording_url: recordingUrl || "",
            rep_name: rep_name || "",
            call_id: call_id || "",
            call_from: call_from || "",
            call_to: call_to || "",
          }),
        });
        console.log("Logged to Sheets");
      } catch (e) {
        console.log("Sheets error:", e.message);
      }
    }

    console.log("Done:", contact_name, "|", analysis.outcome);
    return res.status(200).json({
      success: true,
      contact: contact_name,
      outcome: analysis.outcome,
      duration: call_duration,
      recording: recordingUrl ? "found" : "not found",
    });

  } catch (error) {
    console.error("Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
};
