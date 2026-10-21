package com.addakhana.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;

/** The full-screen incoming call screen, shown over the lock screen while the phone rings. */
public class IncomingCallActivity extends Activity {
    private static WeakReference<IncomingCallActivity> current = new WeakReference<>(null);

    private String callId;
    private boolean video;

    /** The call ended or was answered elsewhere: close the call screen. */
    static void finishFor(String callId) {
        IncomingCallActivity a = current.get();
        if (a != null && callId != null && callId.equals(a.callId)) a.runOnUiThread(a::finish);
    }

    @SuppressWarnings("deprecation")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        callId = getIntent().getStringExtra("callId");
        video = getIntent().getBooleanExtra("video", false);
        if (!ActionReceiver.isId(callId) || IncomingCall.wasEnded(this, callId)) {
            finish();
            return;
        }
        current = new WeakReference<>(this);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(layout(getIntent().getStringExtra("name"), getIntent().getIntExtra("hue", 260)));
    }

    @Override
    protected void onDestroy() {
        if (current.get() == this) current.clear();
        super.onDestroy();
    }

    private View layout(String name, int hue) {
        FrameLayout root = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[] { 0xFF1A1440, 0xFF090C1A });
        root.setBackground(bg);
        root.setFitsSystemWindows(true);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        col.setPadding(dp(24), dp(72), dp(24), dp(56));
        root.addView(col, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        TextView app = text(getString(video ? R.string.incoming_video_call : R.string.incoming_voice_call), 15, 0xFFA7ACD0, false);
        col.addView(app);

        ImageView avatar = new ImageView(this);
        avatar.setImageBitmap(Avatars.bitmap(name, hue, dp(132)));
        LinearLayout.LayoutParams ap = new LinearLayout.LayoutParams(dp(132), dp(132));
        ap.topMargin = dp(40);
        col.addView(avatar, ap);

        TextView who = text(name == null ? "Someone" : name, 30, 0xFFFFFFFF, true);
        LinearLayout.LayoutParams wp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        wp.topMargin = dp(20);
        col.addView(who, wp);
        col.addView(text(getString(R.string.app_name), 14, 0xFF8E93B8, false));

        View spacer = new View(this);
        col.addView(spacer, new LinearLayout.LayoutParams(1, 0, 1f));

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);
        buttons.addView(button(R.drawable.ic_call_end, 0xFFEF4444, getString(R.string.decline), v -> decline()));
        View gap = new View(this);
        buttons.addView(gap, new LinearLayout.LayoutParams(dp(96), 1));
        buttons.addView(button(video ? R.drawable.ic_video : R.drawable.ic_call, 0xFF22C55E, getString(R.string.answer), v -> answer()));
        col.addView(buttons);
        return root;
    }

    private View button(int icon, int color, String label, View.OnClickListener click) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        ImageView b = new ImageView(this);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(color);
        b.setBackground(circle);
        b.setImageResource(icon);
        b.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        b.setPadding(dp(20), dp(20), dp(20), dp(20));
        b.setContentDescription(label);
        b.setOnClickListener(click);
        box.addView(b, new LinearLayout.LayoutParams(dp(72), dp(72)));
        TextView t = text(label, 14, 0xFFEEF0FF, false);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        tp.topMargin = dp(10);
        box.addView(t, tp);
        return box;
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void decline() {
        String id = callId;
        IncomingCall.declined(this, id);
        new Thread(() -> Api.post("/calls/" + id + "/decline", null)).start();
        MainActivity.send(Push.event("decline").put("callId", id));
        finish();
    }

    /** Unlock first (the app itself isn't shown over the lock screen), then open it to join the call. */
    private void answer() {
        KeyguardManager km = getSystemService(KeyguardManager.class);
        if (Build.VERSION.SDK_INT >= 26 && km != null && km.isKeyguardLocked()) {
            km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override
                public void onDismissSucceeded() {
                    openApp();
                }
            });
        } else {
            openApp();
        }
    }

    private void openApp() {
        try {
            IncomingCall.answer(this, callId, video).send();
        } catch (Exception ignored) {
            startActivity(new Intent(this, MainActivity.class).setAction(MainActivity.ACTION_ANSWER)
                    .putExtra("callId", callId).putExtra("video", video).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        finish();
    }
}
