package com.addakhana.app.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.util.concurrent.atomic.AtomicLong

/** Short notes at the bottom of the screen ("Message copied", "Call ended."). */
object Toasts {
    enum class Tone { Info, Error, Live }

    data class Toast(val id: Long, val text: String, val tone: Tone)

    private val ids = AtomicLong()
    private val _items = MutableStateFlow<List<Toast>>(emptyList())
    val items: StateFlow<List<Toast>> = _items.asStateFlow()

    fun show(text: String, tone: Tone = Tone.Info) {
        val toast = Toast(ids.incrementAndGet(), text, tone)
        _items.update { (it + toast).takeLast(4) }
    }

    fun error(text: String) = show(text, Tone.Error)

    fun dismiss(id: Long) = _items.update { list -> list.filterNot { it.id == id } }
}
