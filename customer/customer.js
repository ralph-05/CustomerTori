let currentCustomer = null
let trackOrderUnsub = null
let isGuest = false
let isBookingSubmitting = false
let isOrderSubmitting = false
let db = null
const categories = { 1: "Coffee", 2: "Non-coffee", 3: "Frappe", 4: "Soda", 5: "Pastries" }
let allPromos = []
let customerNoticeCount = 0
const CUSTOMER_NOTICE_KEY = "customer_notice_last_seen"
let lastNoticeSeen = Number(localStorage.getItem(CUSTOMER_NOTICE_KEY) || 0)
let currentInsufficientCount = 0
const seenPaymentConfirmations = new Set()
let customerNotifications = []
let customerNotificationPoller = null
let notificationFeatureEnabled = false
const CUSTOMER_NOTIFICATION_LAST_OPEN_KEY = "customer_notification_last_opened"
let lastNotificationOpened = localStorage.getItem(CUSTOMER_NOTIFICATION_LAST_OPEN_KEY) || ""
let lastBellCount = 0
let isInitialBellLoad = true
let trackPollInterval = null
let wheelIsLoading = false

// Real-time Promos Subscription
let promosUnsub = null
let promosReloadTimer = null
let productsUnsub = null

function subscribeToProductsRealtime() {
  if (!isDbReady()) {
    setTimeout(subscribeToProductsRealtime, 500)
    return
  }

  if (productsUnsub && typeof productsUnsub.unsubscribe === "function") {
    productsUnsub.unsubscribe()
    productsUnsub = null
  }

  productsUnsub = db.channel("customer-products-realtime")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "products" },
      async (payload) => {
        console.log("[System Log] Real-time product update received:", payload.eventType)
        loadMenu() // Reload menu to get updated descriptions/prices
      }
    )
    .subscribe()
}

function normalizeProductRecord(p) {
  const normalized = { ...(p || {}) }
  const name = normalized.name || normalized.product_name || normalized.productName || normalized.product
  const price = normalized.price ?? normalized.product_price ?? normalized.productPrice ?? normalized.product_price
  const imageUrl =
    normalized.image_url ||
    normalized.photo ||
    normalized.image ||
    normalized.photo_url ||
    normalized.photoUrl ||
    normalized.imageUrl ||
    ""

  if (name) normalized.name = String(name).trim()
  if (price !== undefined) normalized.price = Number(price) || 0
  if (imageUrl) normalized.image_url = imageUrl

  // If category_id is missing but a category string exists, keep it for fallback usage
  if (normalized.category_id === undefined && (normalized.category || normalized.category_name || normalized.categoryName)) {
    normalized.category_id = normalized.category_id ?? normalized.category ?? normalized.category_name ?? normalized.categoryName
  }

  return normalized
}

function subscribeToPromosRealtime() {
  if (!isDbReady()) {
    setTimeout(subscribeToPromosRealtime, 500)
    return
  }

  if (promosUnsub && typeof promosUnsub.unsubscribe === "function") {
    promosUnsub.unsubscribe()
    promosUnsub = null
  }

  promosUnsub = db.channel("customer-promos-realtime")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "promos" },
      async (payload) => {
        console.log("[System Log] Real-time promo update received:", payload.eventType)
        
        // Update cache
        const { data: promoData } = await db.from("promos").select("*").order("created_at", { ascending: false });
        allPromos = promoData;

        if (promosReloadTimer) clearTimeout(promosReloadTimer)
        promosReloadTimer = setTimeout(() => loadPromos(), 250)
      }
    )
    .subscribe()
}

function unsubscribePromosRealtime() {
  if (promosUnsub && typeof promosUnsub.unsubscribe === "function") {
    promosUnsub.unsubscribe()
  }
  promosUnsub = null
  if (promosReloadTimer) clearTimeout(promosReloadTimer)
  promosReloadTimer = null
}

window.toggleCategoryDropdown = () => {
  const content = document.getElementById("categoryMenu")
  content.classList.toggle("show")
}

window.selectCategory = (cat, element) => {
  // Update UI for buttons
  document.querySelectorAll(".cat-pill").forEach(item => item.classList.remove("active"))
  if (element) element.classList.add("active")
  
  // Call existing filter function
  if (typeof window.filterCategory === 'function') {
    window.filterCategory(cat, element)
  }
}

// Close dropdown when clicking outside
window.onclick = function(event) {
  if (!event.target.matches('.category-dropbtn') && !event.target.closest('.category-dropbtn')) {
    const dropdowns = document.getElementsByClassName("category-dropdown-content");
    for (let i = 0; i < dropdowns.length; i++) {
      const openDropdown = dropdowns[i];
      if (openDropdown.classList.contains('show')) {
        openDropdown.classList.remove('show');
      }
    }
  }
}

window.customerLogout = () => {
  localStorage.removeItem("customer_auth")
  localStorage.removeItem("customer_cart")
  localStorage.removeItem("customer_preorder_cart")
  location.href = "../index.html"
}

// --- Order Confirmed Modal ---
window.openOrderConfirmedModal = (kind) => {
  const modal = document.getElementById("orderConfirmedModal")
  const text = document.getElementById("orderConfirmedText")
  if (text) {
    if (kind === "preorder") {
      text.innerHTML = "Your <strong>pre-order</strong> has been submitted successfully.<br>You can monitor its status in <strong>Track</strong>."
    } else {
      text.innerHTML = "Your <strong>visit booking</strong> has been submitted successfully.<br>You can monitor its status in <strong>Track</strong>."
    }
  }
  if (modal) modal.style.display = "flex"
}

window.closeOrderConfirmedModal = () => {
  const modal = document.getElementById("orderConfirmedModal")
  if (modal) modal.style.display = "none"
}

window.goToTrackAfterConfirm = () => {
  window.closeOrderConfirmedModal()
  if (typeof showPage === "function") showPage("track")
}

// Real-time Tracking Subscription & Polling
function subscribeToTrackOrderRealtime() {
    if (!db || !currentCustomer) return
    
    // Unsubscribe if already subscribed
    if (trackOrderUnsub && typeof trackOrderUnsub.unsubscribe === 'function') {
        trackOrderUnsub.unsubscribe()
    }

    // Clear existing poll interval
    if (trackPollInterval) {
        clearInterval(trackPollInterval)
    }
    
    const email = currentCustomer.email
    const contact = currentCustomer.contact
    
    // 1. START REAL-TIME
    trackOrderUnsub = db.channel('customer-tracking-realtime')
        .on('postgres_changes', { 
            event: '*', 
            schema: 'public', 
            table: 'pending_orders' 
        }, (payload) => {
            const order = payload.new
            if (order) {
                const orderCustId = String(order.customer_id || "").toLowerCase()
                const matchesEmail = email && orderCustId.includes(email.toLowerCase())
                const matchesContact = contact && orderCustId.includes(contact.toLowerCase())
                
                if (matchesEmail || matchesContact) {
                    console.log("[System Log] Real-time order update received")
                    runTrackOrder().catch(console.error)
                }
            }
        })
        .on('postgres_changes', { 
            event: '*', 
            schema: 'public', 
            table: 'bookings' 
        }, (payload) => {
            const booking = payload.new
            if (booking) {
                const bookingCustId = String(booking.customer_id || "").toLowerCase()
                const matchesEmail = email && bookingCustId.includes(email.toLowerCase())
                const matchesContact = contact && bookingCustId.includes(contact.toLowerCase())
                
                if (matchesEmail || matchesContact) {
                    console.log("[System Log] Real-time booking update received")
                    runTrackOrder().catch(console.error)
                }
            }
        })
        .subscribe()

    // 2. START POLLING FALLBACK (Every 3 seconds for faster monitoring)
     trackPollInterval = setInterval(() => {
         // console.log("[System Log] Polling for tracking updates...")
         runTrackOrder().catch(console.error)
     }, 3000)
 }

// Payment Globals
let selectedPaymentMethod = "cash"
let adminQrUrl = null
let preorderPaymentMethod = "cash"
let repayPaymentMethod = "online"
let repayContext = null

// Dynamic Date Restriction Helper
const updateMinDate = () => {
    const dateInput = document.getElementById("custDate")
    if (!dateInput) return

    const type = document.getElementById("bookType")?.value || "visit";
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const minDate = new Date(today)
    
    // Both pre-orders and visits must be tomorrow or later
    minDate.setDate(minDate.getDate() + 1)
    
    const year = minDate.getFullYear()
    const month = String(minDate.getMonth() + 1).padStart(2, "0")
    const day = String(minDate.getDate()).padStart(2, "0")
    const dateString = `${year}-${month}-${day}`
    
    dateInput.setAttribute("min", dateString)

    // Set max date to 1 year in advance only
    const maxDate = new Date(today)
    maxDate.setFullYear(maxDate.getFullYear() + 1)
    const maxY = maxDate.getFullYear()
    const maxM = String(maxDate.getMonth() + 1).padStart(2, '0')
    const maxD = String(maxDate.getDate()).padStart(2, '0')
    dateInput.setAttribute("max", `${maxY}-${maxM}-${maxD}`)
}

function getBookingDateBounds(type) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const minDate = new Date(today)
  // Both pre-orders and visits must be tomorrow or later
  minDate.setDate(minDate.getDate() + 1)
  const maxDate = new Date(today)
  maxDate.setFullYear(maxDate.getFullYear() + 1)

  const toYMD = (d) => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    return `${y}-${m}-${day}`
  }

  return { min: toYMD(minDate), max: toYMD(maxDate) }
}

function isDateWithinBounds(ymd, bounds) {
  if (!ymd) return false
  const [y, m, d] = String(ymd).split("-").map(Number)
  if (!y || !m || !d) return false
  const value = new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
  const [minY, minM, minD] = String(bounds.min).split("-").map(Number)
  const [maxY, maxM, maxD] = String(bounds.max).split("-").map(Number)
  const minT = new Date(minY, minM - 1, minD, 0, 0, 0, 0).getTime()
  const maxT = new Date(maxY, maxM - 1, maxD, 0, 0, 0, 0).getTime()
  return value >= minT && value <= maxT
}

// --- Booking Dashboard (modals) ---
window.openPreorderSetup = () => {
  if (!currentCustomer) {
    showMessage("Register/Login to pre-order", "error", "bookStatusMessage")
    showAuthModal()
    return
  }
  updateMinDate()
  const modal = document.getElementById("preorderSetupModal")
  const dateEl = document.getElementById("preorderPickupDate")
  const msg = document.getElementById("preorderSetupMsg")
  if (msg) msg.innerHTML = ""
  if (dateEl) {
    const b = getBookingDateBounds("preorder")
    dateEl.min = b.min
    dateEl.max = b.max
    dateEl.value = ""
  }
  const timeEl = document.getElementById("preorderPickupTime")
  if (timeEl) timeEl.value = ""
  if (modal) modal.style.display = "flex"
}

window.closePreorderSetup = () => {
  const modal = document.getElementById("preorderSetupModal")
  if (modal) modal.style.display = "none"
}

window.proceedPreorderSetup = () => {
  const date = document.getElementById("preorderPickupDate")?.value || ""
  const time = document.getElementById("preorderPickupTime")?.value || ""
  const msg = document.getElementById("preorderSetupMsg")
  if (!date || !time) {
    if (msg) msg.innerHTML = `<div class="message error">Please select pickup date and time.</div>`
    return
  }
  const bounds = getBookingDateBounds("preorder")
  if (!isDateWithinBounds(date, bounds)) {
    if (msg) msg.innerHTML = `<div class="message error">Pickup date must be between ${bounds.min} and ${bounds.max}.</div>`
    return
  }
  // Store into existing hidden fields used by submitBooking()
  const typeEl = document.getElementById("bookType")
  if (typeEl) typeEl.value = "preorder"
  const dateEl = document.getElementById("custDate")
  if (dateEl) dateEl.value = date
  const timeEl = document.getElementById("custTime")
  if (timeEl) timeEl.value = time

  updateBookingUI()
  closePreorderSetup()
  openPreorderModal()
}

window.openVisitSetup = () => {
  if (!currentCustomer) {
    showMessage("Register/Login to book a visit", "error", "bookStatusMessage")
    showAuthModal()
    return
  }
  updateMinDate()
  const modal = document.getElementById("visitSetupModal")
  const dateEl = document.getElementById("visitDate")
  const msg = document.getElementById("visitSetupMsg")
  if (msg) msg.innerHTML = ""
  if (dateEl) {
    const b = getBookingDateBounds("visit")
    dateEl.min = b.min
    dateEl.max = b.max
    dateEl.value = ""
  }
  const inEl = document.getElementById("visitCheckIn")
  const outEl = document.getElementById("visitCheckOut")
  if (inEl) inEl.value = ""
  if (outEl) outEl.value = ""
  if (modal) modal.style.display = "flex"
}

window.closeVisitSetup = () => {
  const modal = document.getElementById("visitSetupModal")
  if (modal) modal.style.display = "none"
}

window.submitVisitFromModal = () => {
  const date = document.getElementById("visitDate")?.value || ""
  const checkIn = document.getElementById("visitCheckIn")?.value || ""
  const checkOut = document.getElementById("visitCheckOut")?.value || ""
  const msg = document.getElementById("visitSetupMsg")
  if (!date || !checkIn || !checkOut) {
    if (msg) msg.innerHTML = `<div class="message error">Please select date, check-in and check-out.</div>`
    return
  }
  const bounds = getBookingDateBounds("visit")
  if (!isDateWithinBounds(date, bounds)) {
    if (msg) msg.innerHTML = `<div class="message error">Visit date must be between ${bounds.min} and ${bounds.max}.</div>`
    return
  }
  const typeEl = document.getElementById("bookType")
  if (typeEl) typeEl.value = "visit"
  const dateEl = document.getElementById("custDate")
  if (dateEl) dateEl.value = date
  const inEl = document.getElementById("checkInTime")
  const outEl = document.getElementById("checkOutTime")
  if (inEl) inEl.value = checkIn
  if (outEl) outEl.value = checkOut

  updateBookingUI()
  // Submit using existing logic; messages will go to bookStatusMessage
  submitBooking()
  // Close modal after submit attempt (submitBooking shows errors if any)
  closeVisitSetup()
}

// --- BOOKING LOGIC ---

let groupedProducts = {}
let allProducts = []
let currentMenuCategory = "All"
let currentMenuSearch = ""
let kioskOrder = []
const kioskId = "kiosk_" + Math.random().toString(36).substring(2, 11)
let customerUnsub = null

// Removed conflicting QRCode declaration


function isDbReady() {
  const ready = window.db && typeof window.db.from === "function"
  if (!ready) {
    console.log("[v0] DB not ready - window.db exists:", !!window.db)
  }
  return ready
}

// Validate receipt resolution
function validateReceiptResolution(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = function () {
      if (img.width < 600 || img.height < 800) {
        reject("Receipt resolution too low. Please upload a clearer image (Min: 600x800).")
      } else {
        resolve(true)
      }
    }
    img.onerror = () => reject("Invalid image file.")
    img.src = URL.createObjectURL(file)
  })
}

// Robust update helper
async function safeUpdateRow(table, id, payload) {
  let currentPayload = { ...payload }
  const tryUpdate = async () => db.from(table).update(currentPayload).eq("id", id)
  let { error } = await tryUpdate()
  let attempts = 0
  while (error && attempts < 6) {
    const msg = String(error.message || "")
    let removed = false
    for (const col of Object.keys(currentPayload)) {
      const colHit = msg.includes(`'${col}'`) || msg.includes(`"${col}"`) || msg.includes(` ${col} `)
      const missing = msg.includes("does not exist") || msg.includes("Could not find") || msg.includes("schema cache")
      if (colHit && missing) {
        delete currentPayload[col]
        removed = true
        break
      }
    }
    if (!removed || Object.keys(currentPayload).length === 0) break
    ;({ error } = await tryUpdate())
    attempts++
  }
  if (error) throw error
  return true
}

function playNotificationSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
        const ctx = new AudioContext();
        if (ctx.state === 'suspended') {
            ctx.resume().catch(e => console.warn("Audio resume failed:", e));
        }
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = 880;
        o.connect(g);
        g.connect(ctx.destination);
        g.gain.setValueAtTime(0.001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.1);
        o.start();
        o.stop(ctx.currentTime + 0.3);
    }
  } catch (e) {
      console.warn("Audio playback failed:", e);
  }
}

function updateCustomerBell(count) {
  const bell = document.getElementById("customerBell")
  const badge = document.getElementById("customerBellBadge")
  if (!bell || !badge) return
  const total = Number(count || 0)
  
  // Only play sound if count increased and it's not the initial load
  if (!isInitialBellLoad && total > lastBellCount) {
    playNotificationSound()
  }
  lastBellCount = total
  isInitialBellLoad = false

  badge.style.display = total > 0 ? "inline-block" : "none"
  bell.style.display = currentCustomer ? "flex" : "none"
}

function appendPaymentLog(existing, entry) {
  const safeExisting = String(existing || "").trim()
  const safeEntry = String(entry || "").trim()
  if (!safeEntry) return safeExisting
  if (!safeExisting) return safeEntry
  if (safeExisting.includes(safeEntry)) return safeExisting
  return `${safeExisting} | ${safeEntry}`
}

function formatPaymentLogEntry(amount, remaining) {
  const ts = new Date().toISOString()
  const paid = Number(amount || 0)
  const remain = Number(remaining || 0)
  if (remain > 0) {
    return `Payment made - ${ts} - Amount: \u20B1${paid.toFixed(2)} - Remaining Balance: \u20B1${remain.toFixed(2)}`
  }
  return `Payment made - ${ts} - Amount: \u20B1${paid.toFixed(2)} - Paid`
}

function parsePaymentConfirmedAt(notes) {
  const text = String(notes || "")
  if (!text) return null
  const match = text.match(/payment confirmed at\s*([0-9T:\-:.Z]+)/i)
  const match2 = text.match(/payment made\s*-\s*([0-9T:\-:.Z]+)/i)
  if (match2 && !/\-\s*paid\b/i.test(text)) return null
  const tsRaw = match ? match[1] : (match2 ? match2[1] : null)
  if (!tsRaw) return null
  const ts = Date.parse(tsRaw)
  return Number.isNaN(ts) ? null : ts
}

function maybeRegisterPaymentConfirmation(doc) {
  if (!doc) return
  const ts = parsePaymentConfirmedAt(doc.insufficient_notes || doc.notes || "")
  if (!ts || ts <= lastNoticeSeen) return
  const key = `${doc.id || "order"}:${ts}`
  if (seenPaymentConfirmations.has(key)) return
  seenPaymentConfirmations.add(key)
  customerNoticeCount += 1
  updateCustomerBell(currentInsufficientCount + customerNoticeCount)
}

function buildCustomerIdentityFilter(query) {
  if (!currentCustomer || !query) return query
  const email = currentCustomer.email
  const contact = currentCustomer.contact
  const phone = currentCustomer.phone
  const parts = []
  if (email) parts.push(`customer_id.eq.${email}`, `customer_id.ilike.%${email}%`)
  if (contact) parts.push(`customer_id.eq.${contact}`, `customer_id.ilike.%${contact}%`)
  if (phone) parts.push(`customer_id.eq.${phone}`, `customer_id.ilike.%${phone}%`)
  if (parts.length) return query.or(parts.join(","))
  return query
}

function buildCustomerNotificationQuery() {
  if (!currentCustomer || !db) return null
  let query = db.from("customer_notifications").select("*").order("created_at", { ascending: false }).limit(50)
  return buildCustomerIdentityFilter(query)
}

function parseRemainingFromNotes(text) {
  const safeText = String(text || "")
  if (!safeText) return 0
  if (/\bpayment confirmed at\b/i.test(safeText) || /\-\s*paid\b/i.test(safeText)) return 0
  let match = safeText.match(/remaining balance[:\s]*[^\d]*([\d,.]+)\b/i)
  if (!match) match = safeText.match(/still need(?:ed)?[:\s]*[^\d]*([\d,.]+)\b/i)
  if (!match && /insufficient/i.test(safeText)) {
    match = safeText.match(/(?:\u20B1|PHP)?\s*([\d,.]+)\b/i)
  }
  if (!match) return 0
  const raw = String(match[1] || "").replace(/,/g, "")
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

async function fetchInsufficientOrdersForNotifications() {
  if (!currentCustomer || !db || isGuest) return []
  const results = []
  try {
    let q1 = db.from("pending_orders")
      .select("*")
      .neq("type", "redemption")
      .in("status", ["pending", "preparing", "ready"])
    q1 = buildCustomerIdentityFilter(q1)
    const { data: pending } = await q1
    const pendingList = Array.isArray(pending) ? pending : []
    pendingList.forEach((o) => {
      const notesText = String(o.insufficient_notes || o.notes || "")
      const remaining = Number(o.insufficient_amount_needed || 0) || parseRemainingFromNotes(notesText)
      const hasMarker = o.insufficient_payment === true || remaining > 0 || /insufficient/i.test(notesText)
      if (!hasMarker || remaining <= 0) return
      results.push({
        id: `fallback-pending-${o.id}`,
        order_id: o.id,
        source_table: "pending_orders",
        remaining_amount: remaining,
        status: "unread",
        message: "Additional payment required. Tap to complete payment.",
        created_at: o.updated_at || o.created_at || o.timestamp || new Date().toISOString()
      })
    })
  } catch (_) {}

  try {
    let q2 = db.from("bookings")
      .select("*")
      .in("status", ["pending", "accepted"])
    q2 = buildCustomerIdentityFilter(q2)
    const { data: bookings } = await q2
    const bookingList = Array.isArray(bookings) ? bookings : []
    bookingList.forEach((o) => {
      const notesText = String(o.insufficient_notes || o.notes || "")
      const remaining = Number(o.insufficient_amount_needed || 0) || parseRemainingFromNotes(notesText)
      const hasMarker = o.insufficient_payment === true || remaining > 0 || /insufficient/i.test(notesText)
      if (!hasMarker || remaining <= 0) return
      results.push({
        id: `fallback-booking-${o.id}`,
        order_id: o.id,
        source_table: "bookings",
        remaining_amount: remaining,
        status: "unread",
        message: "Additional payment required. Tap to complete payment.",
        created_at: o.updated_at || o.created_at || o.timestamp || new Date().toISOString()
      })
    })
  } catch (_) {}

  return results
}

async function markNotificationSeen(notificationId) {
  if (!notificationId || !db) return
  try {
    await db.from("customer_notifications")
      .update({ status: "seen", updated_at: new Date().toISOString() })
      .eq("id", notificationId)
      .eq("status", "unread")
  } catch (e) {
    console.warn("[v0] Failed to mark notification seen:", e?.message || e)
  }
}

async function markNotificationPaid(orderId, sourceTable, notificationId) {
  if (!db) return
  try {
    const nowIso = new Date().toISOString()
    if (notificationId) {
      await db.from("customer_notifications")
        .update({ status: "paid", updated_at: nowIso })
        .eq("id", notificationId)
      return
    }
    if (!orderId) return
    let query = db.from("customer_notifications")
      .update({ status: "paid", updated_at: nowIso })
      .eq("order_id", String(orderId))
    if (sourceTable) query = query.eq("source_table", sourceTable)
    await query
  } catch (e) {
    console.warn("[v0] Failed to mark notification paid:", e?.message || e)
  }
}

function renderCustomerNotifications(list) {
  const container = document.getElementById("customerNotificationsList")
  if (!container) return
  const data = Array.isArray(list) ? list : []
  if (!data.length) {
    container.innerHTML = `<div class="notification-empty">No notifications yet.</div>`
    return
  }
  container.innerHTML = ""
  data.forEach((n) => {
    const remaining = Number(n.remaining_amount || 0)
    const status = String(n.status || "unread").toLowerCase()
    const isFallback = String(n.id || "").startsWith("fallback-")
    const message = String(n.message || "").toLowerCase()
    
    // Improved detection logic
    const isPaymentConfirmed = status === "paid" || (remaining === 0 && message.includes("fully paid"))
    const isOrderConfirmed = message.includes("now being prepared") || message.includes("order confirmed")
    const isOrderRejected = message.includes("declined") || message.includes("rejected")
    
    const item = document.createElement("div")
    item.className = `notification-item ${status}`
    item.onclick = () => handleNotificationClick(n.id)
    
    if (isPaymentConfirmed) {
      item.innerHTML = `
        <div class="notification-title" style="color: #2e7d32;">Payment Confirmed</div>
        <div class="notification-meta">Order #${n.order_id || "--"}</div>
        <div class="notification-meta">Your remaining balance has been settled at the counter. Thank you!</div>
        <div style="margin-top: 10px; font-size: 0.85em; color: #2e7d32; font-weight: 700;">
          Order is now fully paid.
        </div>
      `
      item.style.borderLeft = "5px solid #2e7d32"
      item.style.background = "#e8f5e9"
    } else if (isOrderConfirmed) {
      item.innerHTML = `
        <div class="notification-title" style="color: #2e7d32;">Order Confirmed</div>
        <div class="notification-meta">Order #${n.order_id || "--"}</div>
        <div class="notification-meta">${n.message}</div>
        <div style="margin-top: 10px; font-size: 0.85em; color: #2e7d32; font-weight: 700;">
          Your order is now being prepared.
        </div>
      `
      item.style.borderLeft = "5px solid #2e7d32"
      item.style.background = "#e8f5e9"
    } else if (isOrderRejected) {
      item.innerHTML = `
        <div class="notification-title" style="color: #d32f2f;">Order Rejected</div>
        <div class="notification-meta">Order #${n.order_id || "--"}</div>
        <div class="notification-meta">${n.message}</div>
        <div style="margin-top: 10px; font-size: 0.85em; color: #d32f2f; font-weight: 700;">
          Please contact support or try again.
        </div>
      `
      item.style.borderLeft = "5px solid #d32f2f"
      item.style.background = "#ffebee"
    } else {
      item.innerHTML = `
        <div class="notification-title">Additional Payment Required</div>
        <div class="notification-meta">Order #${n.order_id || "--"} - Remaining Balance: \u20B1 ${remaining.toFixed(2)}</div>
        <div class="notification-meta">${n.message || "Please pay the remaining balance upon pickup."}${isFallback ? " (synced from order)" : ""}</div>
        <div style="margin-top: 10px; font-size: 0.85em; color: var(--coffee-medium); font-style: italic;">
          Please settle the remaining balance at the counter during pickup.
        </div>
      `
    }
    container.appendChild(item)
  })
}

function maybeAutoOpenNotification(unreadList) {
  // Auto-opening repayment modal is disabled for now.
  return;
  /*
  if (!unreadList || unreadList.length === 0) return
  const next = unreadList[0]
  if (!next || !next.id) return
  if (String(next.id) === String(lastNotificationOpened)) return
  const modal = document.getElementById("repayModal")
  if (modal && modal.style.display === "flex") return
  lastNotificationOpened = String(next.id)
  localStorage.setItem(CUSTOMER_NOTIFICATION_LAST_OPEN_KEY, lastNotificationOpened)
  handleNotificationClick(next.id)
  */
}

async function fetchCustomerNotifications({ autoOpen = false } = {}) {
  if (!currentCustomer || !db || isGuest) return

  // AUTO-REFRESH CUSTOMER DATA (Points, etc.)
  try {
      const { data: updatedCust, error: custErr } = await db.from("customers")
          .select("*")
          .eq("id", currentCustomer.id)
          .single()
      if (!custErr && updatedCust) {
          currentCustomer = updatedCust
          // If on loyalty page, re-render
          const loyaltyPage = document.getElementById("loyalty")
          if (loyaltyPage && loyaltyPage.style.display !== 'none') {
              renderLoyalty()
          }
      }
  } catch (e) { console.warn("Failed to auto-refresh customer data", e) }

  const query = buildCustomerNotificationQuery()
  if (!query) return
  try {
    const { data, error } = await query
    if (error) throw error
    notificationFeatureEnabled = true
    
    // Deduplicate notifications by source_table and order_id
    const seenMap = new Map()
    const rawData = Array.isArray(data) ? data : []
    
    rawData.forEach(n => {
        const key = `${n.source_table}:${n.order_id}`
        // Prioritize keeping the most recent one or the one with a more 'active' status if needed
        if (!seenMap.has(key) || new Date(n.created_at) > new Date(seenMap.get(key).created_at)) {
            seenMap.set(key, n)
        }
    })
    
    customerNotifications = Array.from(seenMap.values())
    
    const fallback = await fetchInsufficientOrdersForNotifications()
    if (fallback.length) {
      const existingKeys = new Set(customerNotifications.map((n) => `${n.source_table}:${n.order_id}`))
      fallback.forEach((f) => {
        const key = `${f.source_table}:${f.order_id}`
        if (!existingKeys.has(key)) customerNotifications.push(f)
      })
    }
    
    // Unread logic: Only count notifications that are truly 'unread'
    // 'paid' notifications are considered seen once the payment is settled.
    const unread = customerNotifications.filter((n) => {
        const status = String(n.status || "unread").toLowerCase()
        return status === "unread"
    })
    
    updateCustomerBell(unread.length + customerNoticeCount)
    renderCustomerNotifications(customerNotifications)
    if (autoOpen) maybeAutoOpenNotification(unread)
  } catch (e) {
    const msg = String(e?.message || e)
    if (/customer_notifications/i.test(msg)) {
      notificationFeatureEnabled = false
      return
    }
    console.warn("[v0] Notification polling failed:", msg)
  }
}

function startCustomerNotificationPolling() {
  if (customerNotificationPoller || isGuest) return
  fetchCustomerNotifications({ autoOpen: true }).catch(() => {})
  customerNotificationPoller = setInterval(() => {
    fetchCustomerNotifications({ autoOpen: true }).catch(() => {})
  }, 5000)
}

async function handleNotificationClick(notificationId) {
  const notification = customerNotifications.find((n) => String(n.id) === String(notificationId))
  if (!notification) return
  const isFallback = String(notification.id || "").startsWith("fallback-")
  
  // If the notification is marked as 'paid', clicking it should also mark it as 'seen'
  // so that the unread badge (bell count) updates correctly.
  const currentStatus = String(notification.status || "unread").toLowerCase()
  if (!isFallback && (currentStatus === "unread" || currentStatus === "paid")) {
      await markNotificationSeen(notification.id)
  }
  
  // Detached repayment modal for now as requested. 
  // Remaining balance should be paid when pick-up.
  /*
  const modal = document.getElementById("customerNotificationsModal")
  if (modal) modal.style.display = "none"
  openRepayModal(notification.source_table || "pending_orders", notification.order_id, notification.remaining_amount, isFallback ? null : notification.id)
  */
  
  fetchCustomerNotifications({ autoOpen: false }).catch(() => {})
}

window.openCustomerNotifications = async () => {
  lastNoticeSeen = Date.now()
  localStorage.setItem(CUSTOMER_NOTICE_KEY, String(lastNoticeSeen))
  customerNoticeCount = 0
  const modal = document.getElementById("customerNotificationsModal")
  if (modal) modal.style.display = "flex"
  
  // NEW: Automatically mark all notifications as seen when the customer opens the panel
  if (Array.isArray(customerNotifications)) {
    const unreadIds = customerNotifications
      .filter(n => String(n.status || "unread").toLowerCase() === "unread" && !String(n.id || "").startsWith("fallback-"))
      .map(n => n.id)
    
    if (unreadIds.length > 0) {
      try {
        // Mark all unread notifications as seen in the database
        await Promise.all(unreadIds.map(id => markNotificationSeen(id)))
        // Update local state so the badge disappears immediately
        customerNotifications.forEach(n => {
          if (unreadIds.includes(n.id)) n.status = "seen"
        })
        updateCustomerBell(customerNoticeCount) // customerNoticeCount is already 0
      } catch (err) {
        console.warn("[v0] Failed to mark notifications as seen:", err)
      }
    }
  }
  
  fetchCustomerNotifications({ autoOpen: true }).catch(() => {})
}

window.closeCustomerNotifications = () => {
  const modal = document.getElementById("customerNotificationsModal")
  if (modal) modal.style.display = "none"
}

// --- UTILITY FUNCTIONS ---
function generateRandomId(length = 6) {
  const chars = "0123456789"
  let result = ""
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

// --- AUTH FUNCTIONS ---
function showMessage(msg, type, container = "authMessage") {
  const el = document.getElementById(container)
  if (!el) return
  el.innerHTML = `<div class="${type}">${msg}</div>`
  setTimeout(() => (el.innerHTML = ""), 2500)
}

window.showCartToast = (msg = "Your order added to the cart") => {
  const toast = document.getElementById("cartToast");
  if (!toast) return;
  
  toast.textContent = msg;
  toast.classList.add("visible");
  
  // Clear previous timer if any
  if (window.__cartToastTimer) clearTimeout(window.__cartToastTimer);
  
  window.__cartToastTimer = setTimeout(() => {
    toast.classList.remove("visible");
  }, 3000);
};

async function registerCustomer() {
  if (!isDbReady()) {
    showMessage("Database connecting... please try again in a moment", "error")
    console.error("[v0] Database not ready for registration")
    return
  }

  const email = document.getElementById("custEmail").value.trim()
  const phone = document.getElementById("custPhone")?.value.trim() || ""
  const name = document.getElementById("custName").value.trim()

  if ((!email && !phone) || !name) {
    showMessage("Please enter email/phone and name", "error")
    return
  }

  const contact = email || phone
  const loyaltyCard = generateRandomId(6)

  try {
    const { data: newUser, error } = await db.from("customers").upsert({
      name: name,
      email: email || null,
      phone: phone || null,
      contact: contact,
      created_at: new Date().toISOString(),
      loyalty_card: loyaltyCard,
      loyalty_points: 0,
    }).select().single()

    if (error) throw error
    currentCustomer = newUser
    isGuest = false
    showMessage("Registered successfully!", "success")
    renderLoyalty()
    startPortal()
  } catch (error) {
    console.error("[v0] Registration error:", error)
    showMessage("Registration failed: " + error.message, "error")
  }
}

async function findUserByContact(email, phone) {
  try {
    let query = db.from("customers").select("*").order('created_at', { ascending: false }).limit(1)
    
    // Construct OR query if both exist, or specific query
    if (email && phone) {
      query = query.or(`email.ilike.${email},phone.ilike.${phone},contact.ilike.${email},contact.ilike.${phone}`)
    } else if (email) {
      query = query.or(`email.ilike.${email},contact.ilike.${email}`)
    } else if (phone) {
      query = query.or(`phone.ilike.${phone},contact.ilike.${phone}`)
    } else {
      return null
    }

    const { data, error } = await query
    
    if (error) {
       console.warn("Error finding user:", error)
       return null
    }
    
    if (data && data.length > 0) return data[0]
    return null
  } catch (err) {
    console.error("Error finding user:", err)
    return null
  }
}

function loginCustomer() {
  if (!isDbReady()) {
    showMessage("Database connecting... please try again in a moment", "error")
    console.error("[v0] Database not ready for login")
    return
  }

  const email = document.getElementById("custEmail").value.trim()
  const phone = document.getElementById("custPhone")?.value.trim() || ""

  // Allow either email or phone
  if (!email && !phone) {
    showMessage("Enter email or phone number", "error")
    return
  }

  findUserByContact(email, phone)
    .then((user) => {
      if (user) {
        currentCustomer = user
        isGuest = false
        showMessage("Welcome back, " + currentCustomer.name + "!", "success")
        generateLoyaltyCard()
        startPortal()
      } else {
        showMessage("Not found. Please register first.", "error")
      }
    })
    .catch((error) => {
      console.error("[v0] Login error:", error)
      showMessage("Login failed: " + error.message, "error")
    })
}

async function registerFromModal() {
  if (!isDbReady()) {
    showMessage("Database connecting... please try again in a moment", "error", "modalMessage")
    return
  }

  const email = document.getElementById("modalEmail").value.trim()
  const phone = document.getElementById("modalPhone")?.value.trim() || ""
  const name = document.getElementById("modalName").value.trim()
  const password = document.getElementById("modalPassword").value.trim()

  if ((!email && !phone) || !name || !password) {
    showMessage("Please enter email/phone, name, and password", "error", "modalMessage")
    return
  }

  const contact = email || phone

  try {
    const existingUser = await findUserByContact(email, phone)
    if (existingUser) {
      showMessage("You already have an account. Try logging in.", "error", "modalMessage")
      return
    }

    const { error } = await db.from("customers").upsert({
      name: name,
      email: email || null,
      phone: phone || null,
      password: password,
      contact: contact,
      created_at: new Date().toISOString(),
      loyalty_card: null,
      loyalty_points: 0,
    })
    
    if (error) throw error
    currentCustomer = { email: contact, name, contact, loyalty_points: 0 }
    isGuest = false
    closeAuthModal()
    generateLoyaltyCard()
    updateGuestUI()
    reloadPortal()
  } catch (error) {
    console.error("[v0] Registration error:", error)
    showMessage("Registration failed: " + error.message, "error", "modalMessage")
  }
}

async function loginFromModal() {
  if (!isDbReady()) {
    showMessage("Database connecting... please try again in a moment", "error", "modalMessage")
    return
  }

  const email = document.getElementById("modalEmail").value.trim()
  const phone = document.getElementById("modalPhone")?.value.trim() || ""
  const password = document.getElementById("modalPassword").value.trim()

  if ((!email && !phone) || !password) {
    showMessage("Enter email/phone and password", "error", "modalMessage")
    return
  }

  try {
    console.log(`[v0] Attempting login for: ${email || phone}`)
    const user = await findUserByContact(email, phone)
    
    if (user) {
      console.log("[v0] User found:", user.id)
      // Check password if it exists on the user record
      if (user.password && user.password !== password) {
        showMessage("Incorrect password", "error", "modalMessage")
        return
      }
      
      // If user has no password (legacy/guest converted), update it? 
      // For now, allow login but maybe prompt to set password later.
      
      currentCustomer = user
      isGuest = false
      generateLoyaltyCard(true)
      closeAuthModal()
      updateGuestUI()
      reloadPortal()
      showMessage("Login successful!", "success", "authMessage") // Show on main screen too
    } else {
      console.warn("[v0] User not found for:", email || phone)
      showMessage("Not found. Please register first.", "error", "modalMessage")
    }
  } catch (error) {
    console.error("[v0] Login error:", error)
    showMessage("Login failed: " + error.message, "error", "modalMessage")
  }
}

function showAuthModal() {
  const modal = document.getElementById("authModal")
  if (modal) modal.style.display = "flex"
}

function closeAuthModal() {
  const modal = document.getElementById("authModal")
  if (modal) modal.style.display = "none"
  // Clear modal inputs
  document.getElementById("modalEmail").value = ""
  document.getElementById("modalPhone").value = ""
  document.getElementById("modalName").value = ""
  document.getElementById("modalPassword").value = ""
  document.getElementById("modalMessage").innerHTML = ""
}

function goHome() {
  window.location.href = "../index.html"
}

function continueAsGuest() {
  isGuest = true
  currentCustomer = null
  startPortal()
}

function ensureDbReady(callback, retries = 0) {
  if (isDbReady()) {
    callback()
  } else if (retries < 10) {
    console.log("[v0] Waiting for Database... retry " + (retries + 1))
    setTimeout(() => ensureDbReady(callback, retries + 1), 200)
  } else {
    console.error("[v0] Database failed to initialize after retries")
    showMessage("Database connection error. Please refresh the page.", "error", "authMessage")
  }
}

function testDbConnection() {
  const targetEl = document.getElementById("authMessage") || document.getElementById("statusMessage")
  if (!isDbReady()) {
    if (targetEl) targetEl.innerHTML = '<div class="error">Database Error: Not connected</div>'
    return
  }
  db.from("products")
    .select("id")
    .limit(1)
    .then(({ error }) => {
      if (error) throw error
      if (targetEl) targetEl.innerHTML = '<div class="success">Database connected</div>'
      setTimeout(() => {
        if (targetEl) targetEl.innerHTML = ""
      }, 2000)
    })
    .catch((err) => {
      console.error("[v0] Connectivity test failed:", err)
      const msg =
        err?.code === "permission-denied"
          ? "Database connected but access denied. Update Firestore rules."
          : "Database connection issue: " + (err?.message || "unknown error")
      if (targetEl) targetEl.innerHTML = `<div class="error">${msg}</div>`
    })
}

function updateGuestUI() {
  const cartSection = document.getElementById("cartSection")
  const guestPrompt = document.getElementById("guestPrompt")
  const navBook = document.getElementById("navBook")
  const navLoyalty = document.getElementById("navLoyalty")
  const navTrack = document.getElementById("navTrack")

  if (isGuest) {
    // Hide features for guests
    if (cartSection) cartSection.style.display = "none"
    if (guestPrompt) guestPrompt.style.display = "flex"
    if (navBook) navBook.style.display = "none"
    if (navLoyalty) navLoyalty.style.display = "none"
    if (navTrack) navTrack.style.display = "none"
  } else {
    // Show all features for logged-in users
    if (cartSection) cartSection.style.display = "block"
    if (guestPrompt) guestPrompt.style.display = "none"
    if (navBook) navBook.style.display = "flex"
    if (navLoyalty) navLoyalty.style.display = "flex"
    if (navTrack) navTrack.style.display = "flex"
  }
}

function reloadPortal() {
  updateGuestUI()
  // Reload cart if needed
  renderKioskOrder()
}

// --- START PORTAL ---
function startPortal() {
  const authSection = document.getElementById("authSection")
  const mainNav = document.getElementById("mainNav")
  if (authSection) {
    authSection.style.display = "none"
  }
  if (mainNav) {
    mainNav.style.display = "flex"
  }
  
  // Update guest UI to show/hide features based on auth status
  updateGuestUI()
  
  // For guest mode: only show menu
  // For registered users: show all features
  if (isGuest) {
    console.log("[v0] Guest mode - hiding restricted features")
    const navBook = document.getElementById("navBook")
    const navLoyalty = document.getElementById("navLoyalty")
    const navTrack = document.getElementById("navTrack")
    if (navBook) navBook.style.display = "none"
    if (navLoyalty) navLoyalty.style.display = "none"
    if (navTrack) navTrack.style.display = "none"
  } else {
    console.log("[v0] Registered user - showing all features")
    const navBook = document.getElementById("navBook")
    const navLoyalty = document.getElementById("navLoyalty")
    const navTrack = document.getElementById("navTrack")
    if (navBook) navBook.style.display = "flex"
    if (navLoyalty) navLoyalty.style.display = "flex"
    if (navTrack) navTrack.style.display = "flex"
    // Load loyalty card for registered users
    generateLoyaltyCard()
  }
  
  // Load menu page
  showPage("menu")
  // Load menu after DOM is ready
  setTimeout(() => {
    loadMenu()
    subscribeToProductsRealtime()
  }, 100)
  
  // Load payment settings
  loadPaymentSettings()
  
  // Subscribe to real-time customer updates (for points)
  subscribeToCustomer()
  subscribeToOrderUpdates()
  startCustomerNotificationPolling()
  ensureBottomNavRestingPosition()
}

function ensureBottomNavRestingPosition() {
  const root = document.documentElement
  const mainNav = document.getElementById('mainNav')
  const userNavBarHeight = Math.max(window.screen.height - window.innerHeight, 0)

  // Left-fit by default; if system nav gesture area is present, adjust bottom offset accordingly.
  // If no software nav keys (full-gesture), userNavBarHeight often is 0.
  if (userNavBarHeight <= 16) {
    root.style.setProperty('--mobile-nav-bottom', '0px')
    if (mainNav) mainNav.style.setProperty('bottom', '0px')
  } else {
    const offset = `${userNavBarHeight}px`
    root.style.setProperty('--mobile-nav-bottom', offset)
    if (mainNav) mainNav.style.setProperty('bottom', offset)
  }

  // Keep content accessible with safe-area inset and dynamic bottom nav zone
  document.body.style.paddingBottom = `calc(90px + env(safe-area-inset-bottom) + ${Math.round(userNavBarHeight)}px)`
}

window.addEventListener('resize', ensureBottomNavRestingPosition)
window.addEventListener('orientationchange', ensureBottomNavRestingPosition)

function subscribeToCustomer() {
  if (isGuest || !currentCustomer) return
  if (customerUnsub) {
      if (typeof customerUnsub.unsubscribe === 'function') customerUnsub.unsubscribe()
      else if (typeof customerUnsub === 'function') customerUnsub() // Handle legacy
      customerUnsub = null
  }
  
  const email = currentCustomer.email
  const contact = currentCustomer.contact
  
  if (!email && !contact) return

  // Subscribe to both email and contact updates
  customerUnsub = db.channel('customer-updates-' + (contact || email))
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'customers', filter: email ? `email=eq.${email}` : `contact=eq.${contact}` },
      (payload) => {
          const data = payload.new
          currentCustomer = { ...currentCustomer, ...data }
          renderLoyalty()
          runTrackOrder().catch(console.error)
      }
    )
  
  if (email && contact) {
      customerUnsub.on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'customers', filter: `contact=eq.${contact}` },
          (payload) => {
              const data = payload.new
              currentCustomer = { ...currentCustomer, ...data }
              renderLoyalty()
              runTrackOrder().catch(console.error)
          }
      )
  }

  customerUnsub.subscribe()
}

let orderUnsub = null
function subscribeToOrderUpdates() {
  if (isGuest || !currentCustomer) return
  if (orderUnsub) {
      if (typeof orderUnsub.unsubscribe === 'function') orderUnsub.unsubscribe()
      else if (typeof orderUnsub === 'function') orderUnsub()
      orderUnsub = null
  }

  const email = currentCustomer.email
  const contact = currentCustomer.contact
  
  if (!email && !contact) return

  console.log("[v0] Subscribing to order updates for:", contact || email)
  
  // Helper to check if a record belongs to the current customer
  const belongsToCustomer = (record) => {
      if (!record || !record.customer_id) return false
      const rawId = String(record.customer_id)
      // Strip [INSUFFICIENT] prefix if present
      const cleanId = rawId.replace(/^\[INSUFFICIENT[^\]]*\]\s*/i, "").trim()
      return (email && cleanId === email) || (contact && cleanId === contact)
  }

  // Subscribe to all changes and filter client-side to handle ID prefixes
  orderUnsub = db.channel('customer-orders-realtime')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'pending_orders' },
      (payload) => {
          const data = payload?.new || payload?.record || payload
          if (belongsToCustomer(data)) {
              console.log("[v0] Pending Order update received:", payload)
              maybeRegisterPaymentConfirmation(data)
              runTrackOrder().catch(console.error)
          }
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'bookings' },
      (payload) => {
          const data = payload?.new || payload?.record || payload
          if (belongsToCustomer(data)) {
              console.log("[v0] Booking update received:", payload)
              maybeRegisterPaymentConfirmation(data)
              runTrackOrder().catch(console.error)
          }
      }
    )

  orderUnsub.subscribe()
}

document.addEventListener("DOMContentLoaded", () => {
  console.log("[v0] DOMContentLoaded fired")

  // Check URL parameters early to hide auth section if needed
  const params = new URLSearchParams(window.location.search)
  const isGuestParam = params.get("guest") === "true"
  const action = params.get("action")
  const showAuthParam = params.get("showAuth") === "true"
  const hasAuthParams = isGuestParam || action === "register" || action === "login" || showAuthParam || localStorage.getItem("customer_auth")
  
  if (hasAuthParams) {
    const authSection = document.getElementById("authSection")
    if (authSection) authSection.style.display = "none"
  }

  // updateMinDate moved to global scope

  // Initialize Min Date
  const bookTypeEl = document.getElementById("bookType")
  updateMinDate()

  // Wait for Database to be ready
  let retries = 0
  const checkDb = () => {
    if (isDbReady()) {
      console.log("[v0] Database is ready!")
      db = window.db
      
      // Run database cleanup
      runDatabaseCleanup()

      // Check URL parameters for guest/user mode
      const params = new URLSearchParams(window.location.search)
      console.log("[v0] Full URL Search Params:", window.location.search); // Added log
      
      const isGuestParam = params.get("guest") === "true"
      const action = params.get("action")
      const showAuthParam = params.get("showAuth") === "true"
      const contact = params.get("contact")
      const email = params.get("email")
      const phone = params.get("phone")
      const name = params.get("name")
      const password = params.get("password")

      const storedAuth = localStorage.getItem("customer_auth")
      if (storedAuth) {
        console.log("[v0] Found stored authentication - logging in user")
        try {
          currentCustomer = JSON.parse(storedAuth)
          isGuest = false
          startPortal()
          return // Skip other param checks if we already have a session
        } catch (e) {
          console.error("[v0] Error parsing stored auth:", e)
          localStorage.removeItem("customer_auth")
        }
      }

      if (showAuthParam) {
        console.log("[v0] showAuth requested - showing modal")
        isGuest = true // Default to guest mode while showing modal
        startPortal()
        showAuthModal()
      } else if (isGuestParam) {
        console.log("[v0] Guest mode - starting portal")
        isGuest = true
        currentCustomer = null
        startPortal()
      } else if (action === "register") {
        console.log("[v0] Registration mode - registering customer")
        isGuest = false
        // Perform registration and then start portal with full dashboard
        const regContact = contact || email || phone
        
        console.log("[v0] Registration Payload:", {
            name, email, phone, contact: regContact
        });

        if (!regContact) {
            console.error("[v0] Registration failed: Missing contact info");
            window.location.href = '../index.html?error=' + encodeURIComponent("Registration failed: Missing contact info");
            return;
        }

        // Check if user already exists
        findUserByContact(email, phone).then(existingUser => {
            if (existingUser) {
                console.log("[v0] Registration failed: User already exists");
                window.location.href = '../index.html?error=' + encodeURIComponent("You already have an account. Try logging in.");
                return;
            }

            const loyaltyCard = generateRandomId(6)
            
            // Force a specific write to test persistence
            console.log("[v0] Attempting to write to Database...");
            
            db.from("customers")
              .upsert({
                name: name,
                email: email || null,
                phone: phone || null,
                password: password, // Store password
                contact: regContact,
                created_at: new Date().toISOString(),
                loyalty_card: loyaltyCard,
                loyalty_points: 0, // Initialize points
              })
              .then(({ error }) => {
                if (error) throw error
                console.log("[v0] Customer registered successfully - Write Confirmed")
                // alert("Registration Successful! Welcome " + name); // Removed alert, using consistent UI
                currentCustomer = { email: email || null, phone: phone || null, name, contact: regContact, loyalty_card: loyaltyCard, loyalty_points: 0 }
                isGuest = false
                startPortal()
              })
              .catch((error) => {
                console.error("[v0] Registration error details:", error)
                showMessage("Registration Error: " + error.message, "error")
                window.location.href = '../index.html?error=' + encodeURIComponent("Registration failed: " + error.message)
              })
        }).catch(error => {
            console.error("[v0] Error checking existing user:", error);
            window.location.href = '../index.html?error=' + encodeURIComponent("Registration check failed: " + error.message);
        });
      } else if (action === "login") {
        console.log("[v0] Login mode - fetching customer")
        isGuest = false
        
        console.log("[v0] Login Query:", { email, phone });

        // Use findUserByContact to handle login by either email or phone
        // regardless of which was used as the document ID
        findUserByContact(email, phone)
          .then((user) => {
            console.log("[v0] Find User Result:", user);
            if (user) {
              // Verify password if provided
              if (password && user.password && user.password !== password) {
                console.log("[v0] Password mismatch")
                window.location.href = '../index.html?error=' + encodeURIComponent("Incorrect password")
                return
              }

              console.log("[v0] Customer found, starting portal")
              currentCustomer = user
              isGuest = false
              startPortal()
            } else {
              console.log("[v0] Customer not found")
              window.location.href = '../index.html?error=' + encodeURIComponent("Customer not found. Please register first.")
            }
          })
          .catch((error) => {
            console.error("[v0] Login error:", error)
            window.location.href = '../index.html?error=' + encodeURIComponent("Login failed: " + error.message)
          })
      } else {
        console.log("[v0] No action - redirecting to home. Action was:", action)
        window.location.href = '../index.html'
      }
    } else {
      retries++
      if (retries < 15) {
        console.log("[v0] Database not ready yet, retrying... (" + retries + "/15)")
        setTimeout(checkDb, 300)
      } else {
        console.error("[v0] Database failed to initialize after retries")
        showMessage("Database connection failed - please refresh", "error", "authMessage")
        const modal = document.getElementById("authModal")
        if (modal) modal.style.display = "flex"
      }
    }
  }

  checkDb()
})

// --- PAGE NAVIGATION ---
window.showPage = showPage;

function showPage(page) {
  document.querySelectorAll(".page").forEach((p) => (p.style.display = "none"))
  const pageEl = document.getElementById(page)
  if (pageEl) pageEl.style.display = "block"

  // Automatically close mobile nav when switching pages
  if (typeof toggleMobileNav === 'function') {
    const sidebar = document.getElementById('mainNav');
    if (sidebar && sidebar.classList.contains('mobile-active')) {
      toggleMobileNav();
    }
  }

  // Track current page for UI guards (e.g., preorder drawer only on booking page)
  window.__customerCurrentPage = page

  // Automatically close all modals when switching pages
  document.querySelectorAll(".auth-modal").forEach((m) => (m.style.display = "none"))

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.remove("active")
  })
  const activeBtn = document.querySelector(`.nav-btn[data-page="${page}"]`)
  if (activeBtn) activeBtn.classList.add("active")

  const orderDrawerBtn = document.getElementById("orderDrawerBtn")
  const customerBell = document.getElementById("customerBell")
  
  if (orderDrawerBtn) {
    // Show cart only on menu and booking pages (where items can be added)
    orderDrawerBtn.style.display = (page === "menu" || page === "book") ? "flex" : "none"
  }
  
  if (customerBell) {
    // Bell is always visible for notifications
    customerBell.style.display = "flex"
  }

  // Handle Preorder Drawer Button Visibility
  if (page === "book") {
      updateBookingUI()
      // Re-enable the preorder drawer container on booking page (toggle will handle active state)
      const preorderDrawer = document.getElementById("preorderDrawer")
      if (preorderDrawer) preorderDrawer.style.display = "flex"

      // Show preorder drawer button only when bookType is preorder
      const preorderDrawerBtn = document.getElementById("preorderDrawerBtn")
      const isPreorder = document.getElementById("bookType")?.value === "preorder"
      if (preorderDrawerBtn) preorderDrawerBtn.style.display = isPreorder ? "flex" : "none"
  } else {
      const preorderDrawerBtn = document.getElementById("preorderDrawerBtn")
      if (preorderDrawerBtn) preorderDrawerBtn.style.display = "none"

      // Pre-order basket should only exist on the booking page
      const preorderDrawer = document.getElementById("preorderDrawer")
      if (typeof closePreorderDrawer === "function") closePreorderDrawer()
      if (preorderDrawer) preorderDrawer.style.display = "none"
  }

  // Automatically close cart drawers when navigating
  if (typeof closeOrderDrawer === "function") {
    closeOrderDrawer()
  }
  if (typeof closePreorderDrawer === "function") {
    closePreorderDrawer()
  }

  if (page === "book" && !currentCustomer) {
    showMessage("Register/Login to book", "error", "bookStatusMessage")
    showAuthModal()
  }
  if (page === "loyalty" && (!currentCustomer || isGuest)) {
    showMessage("Register/Login to access loyalty card", "error")
    showAuthModal()
  }
  if (page === "loyalty" && currentCustomer) renderLoyalty()
  if (page === "promos") {
    loadPromos()
    subscribeToPromosRealtime()
  } else {
    unsubscribePromosRealtime()
  }
  if (page === "menu") {
    if (!allProducts || allProducts.length === 0) {
      loadMenu()
    }
  }
  if (page === "spin") {
    initWheel()
    // Show tap hint when navigating to wheel
    const hint = document.getElementById('customerTapHint');
    if (hint) {
      hint.style.display = 'block';
      setTimeout(() => { hint.style.opacity = '1'; }, 10);
    }
    setTimeout(() => {
      if (window.__customerCurrentPage === "spin") {
        initWheel()
        updateWheel()
      }
    }, 300)
  }
  if (page === "track") {
    if (!currentCustomer) {
      showMessage("Register/Login to view your orders", "error")
      showAuthModal()
      return
    }
    // Run cleanup before tracking to ensure old items are gone
    runDatabaseCleanup()
    runTrackOrder()
    
    // START REAL-TIME TRACKING for track page
    subscribeToTrackOrderRealtime()
  } else {
      // STOP REAL-TIME TRACKING & POLLING when leaving track page
      if (trackOrderUnsub && typeof trackOrderUnsub.unsubscribe === 'function') {
          trackOrderUnsub.unsubscribe()
          trackOrderUnsub = null
      }
      if (trackPollInterval) {
          clearInterval(trackPollInterval)
          trackPollInterval = null
      }
  }
}

// --- Database Cleanup ---
async function runDatabaseCleanup() {
    if (!isDbReady()) return
    console.log("[System Log] Running database cleanup...")
    
    try {
        const now = new Date()
        const threeDaysAgo = new Date(now)
        threeDaysAgo.setDate(now.getDate() - 3)
        const threeDaysAgoISO = threeDaysAgo.toISOString()

        // 1. Remove completed/rejected/cancelled transactions older than 3 days from pending_orders
        await db.from("pending_orders")
            .delete()
            .in("status", ["completed", "rejected", "cancelled"])
            .lt("created_at", threeDaysAgoISO)

        // 2. Remove completed/rejected/cancelled bookings/preorders older than 3 days
        await db.from("bookings")
            .delete()
            .in("status", ["completed", "rejected", "cancelled"])
            .lt("created_at", threeDaysAgoISO)

        // 3. Delete customer order history (orders table) older than 3 days (Point 2)
        await db.from("orders")
            .delete()
            .lt("timestamp", threeDaysAgoISO)

        // 4. Remove insufficient payment notifications if order is complete (Point 7)
        const { data: completedOrders } = await db.from("pending_orders").select("id").eq("status", "completed")
        if (completedOrders && completedOrders.length > 0) {
            const orderIds = completedOrders.map(o => o.id)
            await db.from("customer_notifications")
              .delete()
              .eq("type", "INSUFFICIENT_PAYMENT")
              .in("order_id", orderIds)
        }

        // 5. Remove 'paid' notifications older than 24 hours
        const oneDayAgo = new Date(now)
        oneDayAgo.setDate(now.getDate() - 1)
        const oneDayAgoISO = oneDayAgo.toISOString()
        await db.from("customer_notifications")
            .delete()
            .eq("status", "paid")
            .lt("updated_at", oneDayAgoISO)

        console.log("[System Log] Database cleanup completed.")
    } catch (err) {
        console.error("Critical error during database cleanup:", err)
    }
}

// --- ORDER DRAWER ---
function toggleOrderDrawer() {
  const drawer = document.getElementById("orderDrawer")
  const btn = document.getElementById("orderDrawerBtn")

  if (!drawer || !btn) return

  drawer.classList.toggle("active")
  btn.classList.toggle("active")
}

function closeOrderDrawer() {
  const drawer = document.getElementById("orderDrawer")
  const btn = document.getElementById("orderDrawerBtn")

  if (drawer && btn) {
    drawer.classList.remove("active")
    btn.classList.remove("active")
    document.body.classList.remove("drawer-open")
  }
}

// --- BOOKING ---
// --- PRE-ORDER LOGIC ---
let preorderSelection = {}
let preorderTempSelections = {} // Track Hot/Cold selection per product name
let currentPreorderCategory = "All"
let currentPreorderSearch = ""
  
 window.updateBookingUI = () => {
    const bookType = document.getElementById("bookType")
    if (!bookType) return
    
    updateMinDate()
    
    const isPreorder = bookType.value === "preorder"
    const visitTimeContainer = document.getElementById("visitTimeContainer")
    const preorderTimeContainer = document.getElementById("preorderTimeContainer")
    const preorderStatusInfo = document.getElementById("preorderStatusInfo")
    const preorderDrawerBtn = document.getElementById("preorderDrawerBtn")
    
    // Update border color of the select based on choice
    bookType.style.borderColor = isPreorder ? "var(--preorder-accent)" : "var(--accent-warm)"

    if (isPreorder) {
        if (visitTimeContainer) visitTimeContainer.style.display = "none"
        if (preorderTimeContainer) preorderTimeContainer.style.display = "block"
        if (preorderStatusInfo) preorderStatusInfo.style.display = (Object.keys(preorderSelection).length > 0) ? "flex" : "none"
        if (preorderDrawerBtn) {
            // only show pre-order drawer on the booking page
            const currentPage = window.__customerCurrentPage || ""
            preorderDrawerBtn.style.display = currentPage === "book" ? "flex" : "none"
        }
        // Do not force-open the preorder modal when the user switches tabs.
        // Only open it when user explicitly chooses the preorder option via UI controls.
        // if (Object.keys(preorderSelection).length === 0) {
        //     openPreorderModal()
        // }
    } else {
        if (visitTimeContainer) visitTimeContainer.style.display = "flex"
        if (preorderTimeContainer) preorderTimeContainer.style.display = "none"
        if (preorderStatusInfo) preorderStatusInfo.style.display = "none"
        if (preorderDrawerBtn) preorderDrawerBtn.style.display = "none"
        if (typeof closePreorderDrawer === "function") closePreorderDrawer()
    }
}

// Initialize UI on load
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById("bookType")) {
        window.updateBookingUI()
    }
})

function openPreorderModal() {
    const modal = document.getElementById("preorderModal")
    if (modal) {
        // If user came from the preorder basket, close it so the modal is visible
        if (typeof closePreorderDrawer === "function") closePreorderDrawer()
        if (typeof closeOrderDrawer === "function") closeOrderDrawer()
        modal.style.display = "flex"
        // Reset to menu view every time it opens
        showPreorderMenuView()
        renderPreorderMenu(currentPreorderCategory)
    }
}

function showPreorderMenuView() {
    const menuView = document.getElementById("preorderMenuView")
    const paymentView = document.getElementById("preorderPaymentSection")
    const backBtn = document.getElementById("preorderBackBtn")
    const cancelBtn = document.getElementById("preorderCancelBtn")
    const nextBtn = document.getElementById("preorderNextBtn")
    const submitBtn = document.getElementById("preorderSubmitBtn")
    const scrollArea = document.getElementById("preorderScrollArea")

    if (menuView) menuView.style.display = "block"
    if (paymentView) paymentView.style.display = "none"
    if (backBtn) backBtn.style.display = "none"
    if (cancelBtn) cancelBtn.style.display = "block"
    if (nextBtn) nextBtn.style.display = "block"
    if (submitBtn) submitBtn.style.display = "none"
    
    // Scroll to top
    if (scrollArea) scrollArea.scrollTop = 0
}

function showPreorderPaymentView() {
    const items = Object.values(preorderSelection)
    if (items.length === 0) {
        showMessage("Please select items for pre-order", "error", "preorderStatusMessage")
        return
    }

    const menuView = document.getElementById("preorderMenuView")
    const paymentView = document.getElementById("preorderPaymentSection")
    const backBtn = document.getElementById("preorderBackBtn")
    const cancelBtn = document.getElementById("preorderCancelBtn")
    const nextBtn = document.getElementById("preorderNextBtn")
    const submitBtn = document.getElementById("preorderSubmitBtn")
    const scrollArea = document.getElementById("preorderScrollArea")

    if (menuView) menuView.style.display = "none"
    if (paymentView) paymentView.style.display = "block"
    if (backBtn) backBtn.style.display = "block"
    if (cancelBtn) cancelBtn.style.display = "none"
    if (nextBtn) nextBtn.style.display = "none"
    if (submitBtn) submitBtn.style.display = "block"
    
    // Scroll to top
    if (scrollArea) scrollArea.scrollTop = 0
    
    // Update summary in payment view
    updatePreorderSummary()
}

function closePreorderModal() {
    const modal = document.getElementById("preorderModal")
    if (modal) modal.style.display = "none"
}

let pendingPreorderSubmit = false

function openPreorderFinalConfirmModal() {
    const summaryDiv = document.getElementById("preorderFinalSummary")
    if (!summaryDiv) return
    
    let itemsSummary = Object.values(preorderSelection).map(item => {
        const sizeText = item.size ? ` (${item.size})` : ''
        return `<div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                  <span style="font-weight:500;">${item.qty}x ${item.name}${sizeText}</span>
                  <span style="font-weight:600; color:#74512D;">PHP ${(Number(item.price) * item.qty).toFixed(2)}</span>
                </div>`
    }).join('')
    
    const dateInput = document.getElementById("custDate")
    const timeInput = document.getElementById("custTime")
    const dateText = dateInput?.value || ''
    const timeText = timeInput?.value || ''
    
    const total = Object.values(preorderSelection).reduce((sum, i) => sum + (Number(i.price) * i.qty), 0)
    
    summaryDiv.innerHTML = `
        <h4 style="color:#543310; margin-top:0; margin-bottom:12px;">Order Summary</h4>
        <div style="margin-bottom:16px; border:1px solid #AF8F6F; border-radius:8px; padding:12px;">
          ${itemsSummary}
          <div style="border-top:1px dashed #AF8F6F; margin-top:12px; padding-top:12px;">
            <div style="display:flex; justify-content:space-between; font-size:1.1rem; font-weight:700;">
              <span style="color:#543310;">Total:</span>
              <span style="color:#74512D;">PHP ${total.toFixed(2)}</span>
            </div>
          </div>
        </div>
        ${dateText ? `<div style="margin-bottom:8px;"><strong>Pickup Date:</strong> ${dateText}</div>` : ''}
        ${timeText ? `<div style="margin-bottom:8px;"><strong>Pickup Time:</strong> ${timeText}</div>` : ''}
        <div style="margin-top:12px;"><strong>Payment Method:</strong> ${preorderPaymentMethod === 'cash' ? 'Cash' : 'Online'}</div>
    `
    
    const modal = document.getElementById("preorderFinalConfirmModal")
    if (modal) modal.style.display = "flex"
}

window.closePreorderFinalConfirmModal = function() {
    const modal = document.getElementById("preorderFinalConfirmModal")
    if (modal) modal.style.display = "none"
}

window.openLimitedTransactionsModal = function() {
    const modal = document.getElementById("limitedTransactionsModal")
    if (modal) modal.style.display = "flex"
}

window.closeLimitedTransactionsModal = function() {
    const modal = document.getElementById("limitedTransactionsModal")
    if (modal) modal.style.display = "none"
}

window.confirmFinalPreorder = function() {
    pendingPreorderSubmit = true
    window.closePreorderFinalConfirmModal()
    submitBooking()
}

document.getElementById("bookType")?.addEventListener("change", updateBookingUI)


function filterPreorderCategory(category, el) {
    document.querySelectorAll("#preorderCategories button").forEach((b) => b.classList.remove("active"))
    if (el) el.classList.add("active")
    currentPreorderCategory = category
    if (typeof closePreorderDrawer === "function") closePreorderDrawer()
    renderPreorderMenu(category)
}

function searchPreorderMenu(query) {
    currentPreorderSearch = (query || "").trim().toLowerCase()
    // Debounce to prevent lag while typing
    if (window.__preorderSearchTimer) clearTimeout(window.__preorderSearchTimer)
    window.__preorderSearchTimer = setTimeout(() => {
      renderPreorderMenu(currentPreorderCategory)
    }, 180)
}

function renderPreorderMenu(category) {
    const list = document.getElementById("preorderMenuGrid")
    if (!list) return
    // Use replaceChildren for faster clears
    list.replaceChildren()
    
    if (!groupedProducts || Object.keys(groupedProducts).length === 0) {
        list.innerHTML = `<p style="text-align:center; width:100%; color:#666;">Menu loading... (Please wait or refresh)</p>`
        return
    }

    // Use groupedProducts directly to match main menu behavior
    let catsToRender = Object.keys(groupedProducts)
    const categoryOrder = ["Coffee", "Non-coffee", "Frappe", "Soda", "Pastries", "Uncategorized"]
    catsToRender = categoryOrder
        .filter((c) => groupedProducts[c])
        .concat(catsToRender.filter((c) => !categoryOrder.includes(c)))

    if (category !== "All") {
        catsToRender = catsToRender.filter(c => c === category)
    }

    // Batch DOM updates to avoid jank on slower devices
    const renderToken = Date.now()
    window.__preorderRenderToken = renderToken

    const frag = document.createDocumentFragment()

    catsToRender.forEach(catName => {
        const products = groupedProducts[catName]
        const filteredProductNames = Object.keys(products).filter(prodName => {
            return !currentPreorderSearch || prodName.toLowerCase().includes(currentPreorderSearch)
        }).sort()

        if (filteredProductNames.length > 0 && category === "All") {
            const header = document.createElement("div")
            header.className = "category-header"
            header.style.gridColumn = "1 / -1"
            header.style.fontSize = "1.2rem"
            header.style.margin = "1.5rem 0 0.8rem 0"
            header.style.color = "var(--preorder-accent)"
            header.style.borderBottom = "2px solid var(--preorder-accent-light)"
            header.style.paddingBottom = "5px"
            
            let icon = ""
            if (catName.includes("Coffee")) icon = "&#9749;"
            else if (catName.includes("Non-coffee")) icon = "&#129380;"
            else if (catName.includes("Frappe")) icon = "&#127848;"
            else if (catName.includes("Soda")) icon = "&#129380;"
            else if (catName.includes("Pastries")) icon = "&#129360;"
            
            header.innerHTML = `<span>${icon}</span> ${catName}`
            frag.appendChild(header)
        }

        filteredProductNames.forEach(prodName => {
            const sizesArr = products[prodName]
            // Sort by price to match main menu behavior
            const sizes = [...sizesArr].sort((a, b) => Number(a.price) - Number(b.price))
            
            // Find first available photo from any size variant
            let basePhoto = null
            for (const s of sizes) {
                basePhoto = s.image_url || s.photo || s.image || null
                if (basePhoto) break
            }

            const itemDiv = document.createElement("div")
            itemDiv.className = "menu-item preorder-item"
            itemDiv.style.display = "flex"
            itemDiv.style.flexDirection = "column"
            
            if (basePhoto) {
                const img = document.createElement("img")
                img.src = basePhoto
                img.alt = prodName
                img.decoding = "async"
                // Eager-load the first few images for perceived speed
                const idx = window.__preorderImgIndex || 0
                img.loading = idx < 8 ? "eager" : "lazy"
                if (idx < 4) img.fetchPriority = "high"
                window.__preorderImgIndex = idx + 1
                img.style.width = "100%"
                img.style.height = "130px"
                img.style.objectFit = "cover"
                img.style.borderRadius = "8px 8px 0 0"
                itemDiv.appendChild(img)
            } else {
                 const placeholder = document.createElement("div")
                 placeholder.style.height = "130px"
                 placeholder.style.background = "#f5f5f5"
                 placeholder.style.borderRadius = "8px 8px 0 0"
                 placeholder.style.display = "flex"
                 placeholder.style.alignItems = "center"
                 placeholder.style.justifyContent = "center"
                 placeholder.innerHTML = "<span style='font-size:2em; opacity:0.3'>&#9749;</span>"
                 itemDiv.appendChild(placeholder)
            }

            const contentDiv = document.createElement("div")
            contentDiv.className = "menu-item-content"
            contentDiv.style.padding = "10px 10px 12px 10px"
            contentDiv.style.display = "flex"
            contentDiv.style.flexDirection = "column"
            contentDiv.style.gap = "4px"
            contentDiv.style.flex = "1"
            contentDiv.style.justifyContent = "space-between" // Ensure space between top and bottom
            
            const topInfo = document.createElement("div") // Wrapper for name and temp
            topInfo.style.display = "flex"
            topInfo.style.flexDirection = "column"
            topInfo.style.gap = "4px"

            const nameTitle = document.createElement("div")
            nameTitle.className = "menu-item-name"
            nameTitle.style.fontSize = "0.9rem"
            nameTitle.style.fontWeight = "bold"
            nameTitle.style.lineHeight = "1.2"
            nameTitle.style.height = "42px" // Fixed height for 3 lines max
            nameTitle.style.display = "-webkit-box"
            nameTitle.style.webkitLineClamp = "3"
            nameTitle.style.webkitBoxOrient = "vertical"
            nameTitle.style.overflow = "hidden"
            nameTitle.style.marginBottom = "2px"
            nameTitle.style.minHeight = "auto" 
            nameTitle.textContent = prodName
            topInfo.appendChild(nameTitle)

            // Add temperature buttons for Coffee category to match main menu
            let selectedTemp = null
            if (catName === "Coffee") {
                // Initialize if not set
                if (!preorderTempSelections[prodName]) preorderTempSelections[prodName] = "Hot"
                selectedTemp = preorderTempSelections[prodName]

                const tempContainer = document.createElement("div")
                tempContainer.className = "temp-buttons"
                tempContainer.style.height = "24px" // Fixed height for alignment
                tempContainer.style.display = "flex"
                tempContainer.style.gap = "6px"
                tempContainer.style.alignItems = "center"
                
                const coldBtn = document.createElement("button")
                coldBtn.className = `temp-btn ${selectedTemp === "Cold" ? "active" : ""}`
                coldBtn.innerHTML = "&#129482;"
                coldBtn.title = "Cold"
                coldBtn.style.padding = "2px 6px"
                coldBtn.style.borderRadius = "4px"
                coldBtn.style.border = "1px solid #ddd"
                coldBtn.style.cursor = "pointer"
                coldBtn.style.fontSize = "11px"
                coldBtn.style.background = selectedTemp === "Cold" ? "var(--preorder-accent-light)" : "white"
                coldBtn.onclick = () => {
                    preorderTempSelections[prodName] = "Cold"
                    renderPreorderMenu(category)
                }
                
                const hotBtn = document.createElement("button")
                hotBtn.className = `temp-btn ${selectedTemp === "Hot" ? "active" : ""}`
                hotBtn.innerHTML = "&#9749;"
                hotBtn.title = "Hot"
                hotBtn.style.padding = "2px 6px"
                hotBtn.style.borderRadius = "4px"
                hotBtn.style.border = "1px solid #ddd"
                hotBtn.style.cursor = "pointer"
                hotBtn.style.fontSize = "11px"
                hotBtn.style.background = selectedTemp === "Hot" ? "var(--preorder-accent-light)" : "white"
                hotBtn.onclick = () => {
                    preorderTempSelections[prodName] = "Hot"
                    renderPreorderMenu(category)
                }
                
                tempContainer.appendChild(coldBtn)
                tempContainer.appendChild(hotBtn)
                topInfo.appendChild(tempContainer)
            } else {
                // Spacer to maintain height for non-coffee items
                const spacer = document.createElement("div")
                spacer.style.height = "24px"
                topInfo.appendChild(spacer)
            }
            
            contentDiv.appendChild(topInfo)

            // Size buttons container
            const sizeButtonsContainer = document.createElement("div")
            sizeButtonsContainer.className = "size-buttons-container"
            sizeButtonsContainer.style.display = "grid"
            sizeButtonsContainer.style.gridTemplateColumns = "repeat(auto-fit, minmax(70px, 1fr))"
            sizeButtonsContainer.style.gap = "6px"
            sizeButtonsContainer.style.marginTop = "8px"

            sizes.forEach(product => {
                const price = Number(product.price || 0)
                const itemKey = selectedTemp ? `${product.id}-${selectedTemp}` : product.id
                const currentQty = preorderSelection[itemKey] ? preorderSelection[itemKey].qty : 0
                const safeName = (product.name || "").replace(/'/g, "\\'")
                const safeSize = (product.size || "").replace(/'/g, "\\'")
                
                let sizeLabel = product.size
                if (!sizeLabel || sizeLabel.toLowerCase() === "reg") {
                    const nameMatch = product.name.match(/\d+(oz|ml|g|kg|L)/i)
                    sizeLabel = nameMatch ? nameMatch[0] : "Regular"
                }

                const sizeBtn = document.createElement("div")
                sizeBtn.className = "size-option-btn-new"
                sizeBtn.style.display = "flex"
                sizeBtn.style.flexDirection = "column"
                sizeBtn.style.alignItems = "center"
                sizeBtn.style.justifyContent = "space-between" // Align label top, action bottom
                sizeBtn.style.padding = "6px 4px"
                sizeBtn.style.minHeight = "65px" // Slightly taller for better alignment
                sizeBtn.style.border = currentQty > 0 ? "2px solid var(--preorder-accent)" : "1px solid #ddd"
                sizeBtn.style.background = currentQty > 0 ? "var(--preorder-accent-light)" : "white"
                
                const labelArea = document.createElement("div")
                labelArea.style.display = "flex"
                labelArea.style.flexDirection = "column"
                labelArea.style.alignItems = "center"
                labelArea.innerHTML = `
                    <span style="font-size: 0.7rem; font-weight: bold;">${sizeLabel}</span>
                    <span style="font-size: 0.65rem; color: var(--preorder-accent);">\u20B1${price.toFixed(2)}</span>
                `
                sizeBtn.appendChild(labelArea)

                const actionArea = document.createElement("div")
                actionArea.style.width = "100%"
                
                if (currentQty > 0) {
                    actionArea.innerHTML = `
                        <div class="qty-control-group preorder-qty-group" style="display: flex; justify-content: center; align-items: center; gap: 4px;">
                            <button type="button" class="qty-btn" style="width:20px; height:20px; padding:0; font-size:11px;" onclick="event.stopPropagation(); updatePreorderQty('${product.id}', '${safeName}', '${safeSize}', ${price}, -1, ${selectedTemp ? `'${selectedTemp}'` : 'null'})">-</button>
                            <span style="font-size:0.8rem; font-weight:bold; min-width:14px; text-align:center;">${currentQty}</span>
                            <button type="button" class="qty-btn" style="width:20px; height:20px; padding:0; font-size:11px;" onclick="event.stopPropagation(); updatePreorderQty('${product.id}', '${safeName}', '${safeSize}', ${price}, 1, ${selectedTemp ? `'${selectedTemp}'` : 'null'})">+</button>
                        </div>
                    `
                } else {
                    const addBtn = document.createElement("button")
                    addBtn.className = "btn-preorder-small"
                    addBtn.style.width = "100%"
                    addBtn.style.padding = "3px"
                    addBtn.style.fontSize = "10px"
                    addBtn.textContent = "Add"
                    addBtn.onclick = (e) => {
                        e.stopPropagation()
                        updatePreorderQty(product.id, safeName, safeSize, price, 1, selectedTemp)
                    }
                    actionArea.appendChild(addBtn)
                }
                
                sizeBtn.appendChild(actionArea)
                sizeButtonsContainer.appendChild(sizeBtn)
            })
            
            contentDiv.appendChild(sizeButtonsContainer)
            itemDiv.appendChild(contentDiv)
            frag.appendChild(itemDiv)
        })
    })

    // Append in a frame so layout is smoother
    requestAnimationFrame(() => {
      if (window.__preorderRenderToken !== renderToken) return
      list.appendChild(frag)
    })
}

function updatePreorderQty(id, name, size, price, change, temperature = null) {
    const itemKey = temperature ? `${id}-${temperature}` : id;
    const displayName = temperature ? `${name} (${temperature})` : name;

    // Robust handler that doesn't depend on looking up groupedProducts again
    if (!preorderSelection[itemKey]) {
        preorderSelection[itemKey] = { 
            id: itemKey, 
            productId: id,
            name: displayName, 
            originalName: name,
            size, 
            price, 
            qty: 0,
            temperature: temperature
        }
    }

    preorderSelection[itemKey].qty += change
    if (preorderSelection[itemKey].qty <= 0) {
        delete preorderSelection[itemKey]
    } else if (change > 0) {
        showCartToast("Your order added to the pre-order cart");
    }

    renderPreorderMenu(currentPreorderCategory)
    updatePreorderSummary()
    renderPreorderCart() // Update cart drawer as well
}

function togglePreorderDrawer() {
    const drawer = document.getElementById("preorderDrawer")
    const btn = document.getElementById("preorderDrawerBtn")

    if (!drawer || !btn) return

    // Guard: pre-order basket only available on Booking page
    if (window.__customerCurrentPage && window.__customerCurrentPage !== "book") return

    // Ensure drawer is available when on booking page
    if (drawer.style.display === "none") drawer.style.display = "flex"

    drawer.classList.toggle("active")
    btn.classList.toggle("active")
    
    if (drawer.classList.contains("active")) {
        renderPreorderCart()
    }
}

function closePreorderDrawer() {
    const drawer = document.getElementById("preorderDrawer")
    const btn = document.getElementById("preorderDrawerBtn")

    if (drawer && btn) {
        drawer.classList.remove("active")
        btn.classList.remove("active")
        document.body.classList.remove("drawer-open")
    }
}

function renderPreorderCart() {
    const container = document.getElementById("preorderItemsContainer")
    const totalEls = document.querySelectorAll(".preorder-total-display")
    const countBadge = document.getElementById("preorderCartBadge")
    const drawerBtn = document.getElementById("preorderDrawerBtn")
    const emptyMsg = document.getElementById("emptyPreorderMessage")
    
    if (!container) return

    container.innerHTML = ""
    let total = 0
    let itemCount = 0
    
    const items = Object.values(preorderSelection)
    
    if (items.length === 0) {
        if (emptyMsg) emptyMsg.style.display = "block"
        totalEls.forEach(el => el.textContent = "0.00")
        if (countBadge && drawerBtn) {
            countBadge.textContent = ""
            drawerBtn.classList.remove("has-items")
        }
        return
    }

    if (emptyMsg) emptyMsg.style.display = "none"

    items.forEach(item => {
        const itemTotal = item.price * item.qty
        total += itemTotal
        itemCount += item.qty
        
        const idToPass = item.productId || item.id
        const nameToPass = (item.originalName || item.name || "").replace(/'/g, "\\'")
        const safeSize = (item.size || "").replace(/'/g, "\\'")
        const tempToPass = item.temperature ? `'${item.temperature}'` : 'null'
        
        const card = document.createElement("div")
        card.className = "cart-item-card"
        
        // Try to find image
        const photo = item.photo || item.image_url || ""
        const imgHtml = photo 
          ? `<img src="${photo}" class="cart-item-img" alt="${item.name}">`
          : `<div class="cart-item-img-placeholder">📅</div>`
          
        card.innerHTML = `
          ${imgHtml}
          <div class="cart-item-info">
            <div class="cart-item-name">${item.name}</div>
            <div class="cart-item-variant">${item.size || "Reg"} ${item.temperature ? `(${item.temperature})` : ""}</div>
            <div class="cart-item-price">₱${item.price.toFixed(2)}</div>
          </div>
          <div class="cart-item-actions">
            <div class="cart-qty-controls">
              <button class="cart-qty-btn" onclick="updatePreorderQty('${idToPass}', '${nameToPass}', '${safeSize}', ${item.price}, -1, ${tempToPass})">−</button>
              <span class="cart-qty-val">${item.qty}</span>
              <button class="cart-qty-btn" onclick="updatePreorderQty('${idToPass}', '${nameToPass}', '${safeSize}', ${item.price}, 1, ${tempToPass})">+</button>
            </div>
            <div class="cart-item-subtotal">₱${itemTotal.toFixed(2)}</div>
            <button class="cart-remove-btn" onclick="updatePreorderQty('${idToPass}', '${nameToPass}', '${safeSize}', ${item.price}, -${item.qty}, ${tempToPass})" title="Remove item">✕</button>
          </div>
        `
        container.appendChild(card)
    })
    
    totalEls.forEach(el => el.textContent = total.toFixed(2))

    if (countBadge && drawerBtn) {
        if (itemCount > 0) {
            countBadge.textContent = String(itemCount)
            drawerBtn.classList.add("has-items")
        } else {
            countBadge.textContent = ""
            drawerBtn.classList.remove("has-items")
        }
    }
}

function updatePreorderSummary() {
    const summaryList = document.getElementById("preorderSummaryList")
    const totalEls = document.querySelectorAll(".preorder-total-display")
    if (!summaryList) return

    const items = Object.values(preorderSelection)
    if (items.length === 0) {
        summaryList.textContent = "No items selected"
        totalEls.forEach(el => el.textContent = "0.00")
        return
    }

    let total = 0
    let html = "<ul style='padding-left: 20px; margin: 0; font-size: 0.9em;'>"
    items.forEach(item => {
        const itemTotal = item.price * item.qty
        total += itemTotal
        html += `<li>${item.name} (${item.size || 'Reg'}) x ${item.qty} - ₱${itemTotal.toFixed(2)}</li>`
    })
    html += "</ul>"
    
    summaryList.innerHTML = html
    totalEls.forEach(el => el.textContent = total.toFixed(2))
}

function submitBooking() {
  if (isBookingSubmitting) return
  
  if (!isDbReady()) {
    showMessage("Database connecting... please try again", "error", "bookStatusMessage")
    return
  }

  if (!currentCustomer) {
    const isPreorderModal = document.getElementById("preorderModal")?.style.display === "flex";
    const msgContainer = isPreorderModal ? "preorderStatusMessage" : "bookStatusMessage";
    showMessage("Register/Login first", "error", msgContainer);
    return;
  }

  const date = document.getElementById("custDate").value;
  const type = document.getElementById("bookType").value;
  const isPreorderModal = document.getElementById("preorderModal")?.style.display === "flex";
  const msgContainer = isPreorderModal ? "preorderStatusMessage" : "bookStatusMessage";

  if (!date) {
    showMessage("Please select a date for your booking.", "error", msgContainer);
    return;
  }

  let items = ""
  let total = 0
  if (type === "preorder") {
      const selected = Object.values(preorderSelection)
      if (selected.length === 0) {
          showMessage("Please select items for pre-order", "error", msgContainer)
          isBookingSubmitting = false
          return
      }
      // items should be the JSON string for consistency with POS/Reports
      items = JSON.stringify(selected.map(i => ({
          id: i.id,
          name: i.name,
          price: i.price,
          qty: i.qty,
          size: i.size || 'Reg'
      })))
      total = selected.reduce((sum, i) => sum + (i.price * i.qty), 0)
  } else {
      items = ""
      total = 0
  }
  
  // Resolve time inputs
  const isPreorder = type === "preorder"
  const pickupTime = document.getElementById("custTime")?.value || ""
  const checkIn = document.getElementById("checkInTime")?.value || ""
  const checkOut = document.getElementById("checkOutTime")?.value || ""
  
  // Validate booking date is not before allowed min
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const [year, month, day] = date.split("-").map(Number)
  const selectedDate = new Date(year, month - 1, day, 0, 0, 0, 0)

  // Block previous dates for everyone
  if (selectedDate < today) {
    showMessage("Date cannot be in the past.", "error", msgContainer)
    return
  }

  // Restrict to current year only per user request
  if (selectedDate.getFullYear() !== today.getFullYear()) {
    showMessage(`Please select a date within the current year (${today.getFullYear()}).`, "error", msgContainer)
    return
  }

  // Pre-orders can be same day, but visits must be tomorrow
  if (!isPreorder && selectedDate <= today) {
    showMessage("Bookings must be made at least 1 day in advance.", "error", msgContainer)
    return
  }

  if (isPreorder && !pickupTime) {
    showMessage("Select pickup time", "error", msgContainer)
    return
  }

  if (!isPreorder && (!checkIn || !checkOut)) {
    showMessage("Select check-in and check-out times", "error", msgContainer)
    return
  }

  // Validate time windows
  const parseHM = (v) => {
    const [h, m] = v.split(":").map(Number)
    return { h, m, total: h * 60 + m }
  }
  const visitStart = 8 * 60
  const visitEnd = 18 * 60
  const poStart = 8 * 60 // 8:00 AM
  const poEnd = 18 * 60 // 6:00 PM
  
  if (isPreorder) {
    const pick = parseHM(pickupTime).total
    if (pick < poStart || pick > poEnd) {
      showMessage("Pre-order pickup is available from 8:00 AM to 6:00 PM.", "error", msgContainer)
      return
    }
  } else {
    const start = parseHM(checkIn).total
    const end = parseHM(checkOut).total
    if (start < visitStart || start > visitEnd || end < visitStart || end > visitEnd) {
      showMessage("Visits are only available from 8:00 AM to 6:00 PM.", "error", msgContainer)
      return
    }
    if (start >= end) {
      showMessage("Check-out time must be after check-in time.", "error", msgContainer)
      return
    }
  }

  isBookingSubmitting = true
  const submitBtn = isPreorderModal 
    ? document.querySelector(".btn-preorder-submit") 
    : document.querySelector("#book .btn-primary")

  // Inform user clearly that order submission is in process.
  const processingModal = document.getElementById("processingModal");
  if (processingModal) processingModal.style.display = "flex";
    
  if (submitBtn) {
    submitBtn.disabled = true
    submitBtn.textContent = "Submitting..."
  }

  const processBooking = async () => {
      let proofUrl = null
      
      if (type === 'preorder' && preorderPaymentMethod === 'online') {
          const fileInput = document.getElementById("preorderProof")
          const file = fileInput?.files[0]
          
          if (!file) {
              throw new Error("Please attach proof of payment (receipt).")
          }

          // Point 1: Validate resolution
          try {
            await validateReceiptResolution(file)
          } catch (resErr) {
            throw new Error(resErr)
          }
          
          if (submitBtn) submitBtn.textContent = "Uploading Receipt..."
          
          const timestamp = Date.now()
          const fileName = `proof_preorder_${timestamp}_${Math.random().toString(36).substring(2, 7)}`
          const { data, error } = await db.storage.from('product-photos').upload(fileName, file)
          
          if (error) throw new Error("Upload failed: " + error.message)
          
          const { data: { publicUrl } } = db.storage.from('product-photos').getPublicUrl(fileName)
          proofUrl = publicUrl
      }

      // Check for day availability (Already implemented logic to check for existing table bookings)
      const checkDay = db.from("bookings")
        .select("status, type, check_in_time, check_out_time")
        .eq("date", date)
        .eq("status", "accepted")
        
      const checkSlot = db.from("bookings")
        .select("*")
        .eq("date", date)
        .eq("status", "accepted")

      const checkUser = db.from("bookings")
        .select("*")
        .eq("customer_id", currentCustomer.contact || currentCustomer.email)

      const [slotRes, userRes, dayRes] = await Promise.all([checkSlot, checkUser, checkDay])

      if (slotRes.error) throw slotRes.error
      if (userRes.error) throw userRes.error
      if (dayRes.error) throw dayRes.error

      if (dayRes.data && dayRes.data.length > 0) {
          const hasTableBooking = dayRes.data.some(b => b.type === 'visit' || b.type === 'book')
          if (hasTableBooking && (type === 'visit' || type === 'book')) {
             // Logic: If there's already a visit booking on this date, we must check if time overlaps
             // To simplify and avoid double visit booking on same date entirely as requested:
             throw new Error("This date is already booked for a visit. Please choose another date or time.")
          }
      }

      /* 
       * REMOVED TIME SLOT CHECK per user request:
       * Pre-orders should not be rejected. 
       * Table bookings are already checked by date availability above.
       */
      /*
      if (slotRes.data && slotRes.data.length > 0) {
        throw new Error("This time slot is already fully booked.")
      }
      */
      
      const snapshot = userRes.data || []
      
      // Limit checks per user request:
      // 1. Max 1 active pre-order per customer
      // 2. Max 1 active booking per customer
      // 3. Max 2 active kiosk orders per customer
      // "Active" means status is not 'completed', 'rejected', or 'cancelled'.
      
      let activePreorders = 0
      let activeBookings = 0

      snapshot.forEach(b => {
          if (b.status !== 'completed' && b.status !== 'rejected' && b.status !== 'cancelled') {
              if (b.type === 'preorder') {
                  activePreorders++
              } else {
                  activeBookings++
              }
          }
      })

      if (type === 'preorder' && activePreorders >= 1) {
          isBookingSubmitting = false
          if (submitBtn) {
            submitBtn.disabled = false
            submitBtn.textContent = "Submit"
          }
          const processingModal = document.getElementById("processingModal");
          if (processingModal) processingModal.style.display = "none";
          
          window.openLimitedTransactionsModal()
          return
      }

      if (type !== 'preorder' && activeBookings >= 1) {
          isBookingSubmitting = false
          if (submitBtn) {
            submitBtn.disabled = false
            submitBtn.textContent = "Submit"
          }
          const processingModal = document.getElementById("processingModal");
          if (processingModal) processingModal.style.display = "none";
          
          window.openLimitedTransactionsModal()
          return
      }
      
      const now = new Date().toISOString()
      const payload = {
        customer_id: currentCustomer.contact || currentCustomer.email,
        type,
        items,
        total,
        date,
        // IMPORTANT: do not store "HH:MM-HH:MM" in a TIME/TIMETZ column (Postgres parses it like a timezone offset)
        // For visits we store the start time in `time` and the full window in `check_in_time`/`check_out_time`.
        time: isPreorder ? pickupTime : (checkIn || null),
        check_in_time: isPreorder ? null : checkIn,
        check_out_time: isPreorder ? null : checkOut,
        pickup_time: isPreorder ? pickupTime : null,
        status: "pending",
        created_at: now,
        payment_method: type === 'preorder' ? preorderPaymentMethod : 'cash',
        proof_of_payment: proofUrl
      }

      // Robust insert that handles missing columns
      const tryInsert = async (p) => {
        const { error } = await db.from("bookings").insert([p])
        return error
      }

      let insertError = await tryInsert(payload)
      if (insertError) {
          console.warn("[v0] Initial booking insert failed, trying fallback:", insertError.message)
          // If total column is missing, remove it and try again
          if (insertError.message.includes("total") || insertError.message.includes("column")) {
              const { total, ...fallbackPayload } = payload
              insertError = await tryInsert(fallbackPayload)
          }
      }
      
      if (insertError) throw insertError
  }

  processBooking()
    .then(() => {
      isBookingSubmitting = false
      const processingModal = document.getElementById("processingModal");
      
      // Delay closing to let user see the processing state
      setTimeout(() => {
        const title = document.getElementById("processingModalTitle");
        const text = document.getElementById("processingModalText");
        const spinner = document.querySelector("#processingModal .processing-spinner");
        
        if (title) title.textContent = "Order Sent!";
        if (text) text.textContent = "Your booking has been successfully submitted.";
        if (spinner) spinner.style.display = "none";

        setTimeout(() => {
          if (processingModal) processingModal.style.display = "none";
          // Reset for next time
          if (title) title.textContent = "Order is on process";
          if (text) text.textContent = "Please wait while we handle your request...";
          if (spinner) spinner.style.display = "block";
          
          showMessage("Booking submitted! You can view it in the Track section.", "success", msgContainer)
          try { window.openOrderConfirmedModal(type) } catch (_) {}
        }, 2500);
      }, 1000);

      document.getElementById("custDate").value = ""
      document.getElementById("preorderItems").value = ""
      if (document.getElementById("custTime")) document.getElementById("custTime").value = ""
      const fileInput = document.getElementById("preorderProof")
      if (fileInput) fileInput.value = ""
      
      // Clear Pre-order Data
      preorderSelection = {}
      renderPreorderMenu(currentPreorderCategory)
      renderPreorderCart()
      updatePreorderSummary()
      if (typeof closePreorderDrawer === 'function') closePreorderDrawer()

      // Reset UI - Switch back to 'Book a Visit' or just hide pre-order section
      const bookTypeSelect = document.getElementById("bookType")
      if (bookTypeSelect) {
          bookTypeSelect.value = "visit" 
      }

      // Reset Payment Method
      preorderPaymentMethod = "cash" // Reset global variable
      const cashRadio = document.querySelector('input[name="preorderPaymentMethod"][value="cash"]')
      if (cashRadio) cashRadio.checked = true
      const onlinePaymentDiv = document.getElementById("preorderPaymentOnline")
      if (onlinePaymentDiv) onlinePaymentDiv.style.display = "none"

      // Automatically close the pre-order modal
      if (typeof window.closePreorderModal === 'function') {
          window.closePreorderModal()
      }

      if (submitBtn) {
        submitBtn.disabled = false
        submitBtn.textContent = "Submit Booking"
      }
      runTrackOrder().catch(console.error)
    })
    .catch((err) => {
      isBookingSubmitting = false
      const processingModal = document.getElementById("processingModal");
      
      setTimeout(() => {
        if (processingModal) processingModal.style.display = "none";
        console.error("[v0] Booking error:", err)
        let msg = err.message || "Unknown error"
        showMessage("Failed to submit booking: " + msg, "error", msgContainer)
        if (submitBtn) {
          submitBtn.disabled = false
          submitBtn.textContent = "Submit Booking"
        }
      }, 1000);
    })
}

window.submitBooking = submitBooking
window.updatePreorderQty = updatePreorderQty
window.togglePreorderDrawer = togglePreorderDrawer
window.closePreorderDrawer = closePreorderDrawer
window.renderPreorderCart = renderPreorderCart
window.openPreorderModal = openPreorderModal
window.closePreorderModal = closePreorderModal

// Validate receipt image quality and clarity
window.validateReceiptImage = (fileInput, type = 'preorder') => {
    const warningId = type === 'payment' ? 'paymentProofWarning' : (type === 'repay' ? 'repayProofWarning' : 'preorderProofWarning')
    const warningEl = document.getElementById(warningId)
    if (!warningEl) return
    
    if (!fileInput.files || fileInput.files.length === 0) {
        warningEl.style.display = 'none'
        return
    }
    
    const file = fileInput.files[0]
    const issues = []
    
    // Check file size (should be < 10MB)
    if (file.size > 10 * 1024 * 1024) {
        issues.push('File is too large (over 10MB)')
    }
    
    // Check image dimensions for clarity
    const reader = new FileReader()
    reader.onload = (e) => {
        const img = new Image()
        img.onload = () => {
            // Check if image is too small (unclear/blurry)
            if (img.width < 400 || img.height < 300) {
                issues.push('Image resolution is too low - receipt details may be unclear')
            }
            
            // Display warnings if any
            if (issues.length > 0) {
                warningEl.style.background = '#fff3cd'
                warningEl.style.border = '1px solid #ffc107'
                warningEl.style.color = '#856404'
                warningEl.innerHTML = '<strong>&#9888; Warning:</strong> ' + issues.join('. ') + '. Please upload a clearer image.'
                warningEl.style.display = 'block'
            } else {
                warningEl.style.display = 'none'
            }
        }
        img.src = e.target.result
    }
    reader.readAsDataURL(file)
}
window.showPreorderMenuView = showPreorderMenuView
window.showPreorderPaymentView = showPreorderPaymentView
window.filterPreorderCategory = filterPreorderCategory
window.searchPreorderMenu = searchPreorderMenu
window.renderPreorderMenu = renderPreorderMenu
window.updatePreorderSummary = updatePreorderSummary
window.openPreorderFinalConfirmModal = openPreorderFinalConfirmModal
window.viewLoyaltyHistory = viewLoyaltyHistory
window.showPage = showPage
window.registerCustomer = registerCustomer
window.loginCustomer = loginCustomer
window.continueAsGuest = continueAsGuest
window.showAuthModal = showAuthModal
window.closeAuthModal = closeAuthModal
window.goHome = goHome
window.registerFromModal = registerFromModal
window.loginFromModal = loginFromModal

window.filterCategory = (category, el) => {
  document.querySelectorAll(".cat-pill").forEach((b) => b.classList.remove("active"))
  if (el) el.classList.add("active")
  currentMenuCategory = category
  if (typeof closeOrderDrawer === "function") closeOrderDrawer()
  renderMenu(category)
}

// --- LOYALTY QR ---
function generateUniqueId(attempt = 0) {
  const maxAttempts = 5
  if (attempt >= maxAttempts) {
    console.error("[v0] Failed to generate unique ID after", maxAttempts, "attempts")
    return
  }

  // Generate multiple candidate IDs to reduce database queries
  const candidateIds = []
  for (let i = 0; i < 3; i++) {
    candidateIds.push(generateRandomId(6))
  }

  // Check all candidates in a single batch query
  db.from("customers")
    .select("loyalty_card")
    .in("loyalty_card", candidateIds)
    .then(({ data, error }) => {
      if (error) {
        console.error("[v0] Error checking ID uniqueness:", error)
        return
      }

      const usedIds = new Set()
      if (data) {
        data.forEach(doc => {
          usedIds.add(doc.loyalty_card)
        })
      }

      // Find first unused ID
      const newId = candidateIds.find(id => !usedIds.has(id))

      if (newId) {
        // ID is unique, save it silently in background
        db.from("customers")
          .update({ loyalty_card: newId })
          .eq("contact", currentCustomer.contact || currentCustomer.email)
          .then(({ error }) => {
            if (error) {
               console.error("[v0] Error saving loyalty card:", error)
               return
            }
            console.log("[v0] Loyalty card assigned:", newId)
            currentCustomer.loyalty_card = newId
            renderLoyalty()
          })
      } else {
        // All candidates were taken, try again
        console.log("[v0] ID collision on all candidates, retrying... (attempt", attempt + 1, ")")
        setTimeout(() => generateUniqueId(attempt + 1), 100 * Math.pow(2, attempt))
      }
    })
}

function generateLoyaltyCard(skipFetch = false) {
  if (!currentCustomer) return
  console.log("[v0] Checking loyalty card for:", currentCustomer.email)

  // If customer already has a loyalty card, just render it instantly
  if (currentCustomer.loyalty_card) {
    console.log("[v0] Loyalty card already exists:", currentCustomer.loyalty_card)
    renderLoyalty()
    return
  }

  // For old accounts without IDs, generate one in the background (non-blocking)
  console.log("[v0] Generating new loyalty card for old account...")
  
  generateUniqueId()
}

let selectedRedeemDrink = null

function openRedeemModal() {
    const modal = document.getElementById("redeemModal")
    if (modal) modal.style.display = "flex"
    loadRedeemDrinks()
}

function closeRedeemModal() {
    const modal = document.getElementById("redeemModal")
    if (modal) modal.style.display = "none"
}

function loadRedeemDrinks() {
    const list = document.getElementById("redeemDrinkList")
    if (!list) return
    list.innerHTML = ""

    // Filter groupedProducts for Coffee, Non-coffee, Frappe, and Soda categories
    const drinkCats = ["Coffee", "Non-coffee", "Frappe", "Soda"]
    
    drinkCats.forEach(cat => {
        if (!groupedProducts[cat]) return
        
        Object.entries(groupedProducts[cat]).forEach(([name, sizes]) => {
            // Find 16oz variant that is available
            const variant = sizes.find(s => String(s.size).toLowerCase().includes("16oz") && s.is_available !== false)
            
            if (variant) {
                const card = document.createElement("div")
                card.className = "redeem-drink-card"
                card.style = "border: 1px solid #ddd; border-radius: 8px; padding: 10px; cursor: pointer; text-align: center; transition: all 0.2s;"
                card.onclick = () => selectRedeemDrink(variant, name, card)
                
                const img = document.createElement("img")
                img.src = variant.image_url || variant.photo || ""
                img.style = "width: 100%; height: 80px; object-fit: cover; border-radius: 4px; margin-bottom: 8px;"
                img.onerror = () => { img.style.display = 'none' }
                
                const title = document.createElement("div")
                title.style = "font-size: 0.85rem; font-weight: 600; color: #333;"
                title.textContent = name
                
                card.appendChild(img)
                card.appendChild(title)
                list.appendChild(card)
            }
        })
    })
}

function selectRedeemDrink(variant, name, cardEl) {
    selectedRedeemDrink = { ...variant, product_name: name }
    
    // Highlight selected card
    document.querySelectorAll(".redeem-drink-card").forEach(c => {
        c.style.borderColor = "#ddd"
        c.style.backgroundColor = "transparent"
    })
    cardEl.style.borderColor = "var(--accent-warm)"
    cardEl.style.backgroundColor = "rgba(212, 165, 116, 0.1)"
    
    // Enable submit button
    const btn = document.getElementById("confirmRedeemBtn")
    if (btn) btn.disabled = false
}

function submitRedemption() {
  if (!currentCustomer || currentCustomer.loyalty_points < 10 || !selectedRedeemDrink) return
  
  const submitBtn = document.getElementById("confirmRedeemBtn")
  if (submitBtn) {
      submitBtn.disabled = true
      submitBtn.textContent = "Processing..."
  }

  // Create redemption request with selected drink
  const redemptionData = {
    type: 'redemption',
    customer_id: currentCustomer.contact,
    customer_name: currentCustomer.name,
    loyalty_card: currentCustomer.loyalty_card,
    status: 'pending',
    timestamp: new Date(),
    // Include selected drink in items for cashier
    items: JSON.stringify([{
        id: selectedRedeemDrink.id,
        name: selectedRedeemDrink.product_name,
        size: selectedRedeemDrink.size,
        quantity: 1,
        price: 0, // It's free!
        is_redemption: true
    }]),
    total: 0
  }
  
  console.log("[v0] Submitting redemption request:", redemptionData)
  
  db.from("pending_orders").insert([redemptionData])
    .select()
    .single()
  .then(({ data: doc, error }) => {
    if (error) throw error
    const docId = doc.id
    showMessage("Redemption request sent! Please wait for confirmation.", "info", "redeemMessage")
    
    // Update main redeem button state
    const mainBtn = document.getElementById("redeemBtn")
    if (mainBtn) {
        mainBtn.disabled = true
        mainBtn.textContent = "Waiting for confirmation..."
    }

    setTimeout(() => {
        closeRedeemModal()
    }, 2000)
    
    // Listen for status changes
    const channel = db.channel('redemption-updates-' + docId)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'pending_orders', filter: `id=eq.${docId}` },
        (payload) => {
            const data = payload.new
            if (data.status === 'preparing') {
                showMessage("Your free drink is being prepared!", "success")
                db.removeChannel(channel)
                 db.from("customers").select("loyalty_points").eq("contact", currentCustomer.contact).maybeSingle()
                 .then(({ data }) => {
                    if(data) {
                        currentCustomer.loyalty_points = data.loyalty_points
                        renderLoyalty()
                    }
                 })
            } else if (data.status === 'confirmed') { // Legacy or combined order flow
                showMessage("Redemption Successful! Your drink has been added to your order.", "success")
                db.removeChannel(channel)
                 db.from("customers").select("loyalty_points").eq("contact", currentCustomer.contact).maybeSingle()
                 .then(({ data }) => {
                    if(data) {
                        currentCustomer.loyalty_points = data.loyalty_points
                        renderLoyalty()
                    }
                 })
            } else if (data.status === 'rejected') {
                showMessage("Redemption Request Rejected", "error")
                db.removeChannel(channel)
                 if (mainBtn) {
                     mainBtn.disabled = false
                     mainBtn.textContent = "Redeem Free Drink (10 pts)"
                 }
            }
        }
      )
      .subscribe()
  }).catch(err => {
    console.error("Redemption failed", err)
    showMessage("Failed to request redemption", "error", "redeemMessage")
    if (submitBtn) {
        submitBtn.disabled = false
        submitBtn.textContent = "Confirm Selection"
    }
  })
}

function redeemFreeDrink() {
    // This function is replaced by openRedeemModal
    openRedeemModal()
}

function checkActiveRedemption() {
   if (!currentCustomer) return
   
   // Check for pending requests first
   db.from("pending_orders")
     .select("*")
     .eq("type", "redemption")
     .eq("customer_id", currentCustomer.contact)
     .eq("status", "pending")
     .limit(1)
     .then(({ data, error }) => {
         if (error) {
            console.error("Error checking active redemption:", error)
            return
         }
         
         const redeemBtn = document.getElementById('redeemBtn')
         const stampGrid = document.getElementById("stampGrid")
         
         if (data && data.length > 0) {
             if (redeemBtn) {
                 redeemBtn.style.display = 'block'
                 redeemBtn.disabled = true
                 redeemBtn.textContent = "Waiting for cashier confirmation..."
             }
             if (stampGrid) {
                stampGrid.onclick = null
                stampGrid.style.cursor = "default"
             }
         } 
         // Note: We don't handle the 'else' case here because we already set the default state
         // in renderLoyalty based on points. This function ONLY checks for pending status override.
     })
}



function renderLoyalty() {
  const card = currentCustomer?.loyalty_card
  const cardDisplay = document.getElementById("loyaltyCardDisplay")
  
  if (cardDisplay) {
    if (card) {
       cardDisplay.textContent = card
    } else {
       // Placeholder for accounts still being processed
       cardDisplay.textContent = "--"
       }
    }
  
  // Update points balance
  const points = currentCustomer?.loyalty_points || 0
  const pointsDisplay = document.getElementById("loyaltyPointsDisplay")
  if (pointsDisplay) {
    pointsDisplay.textContent = points
  }
  
  // Show/Hide redeem button based on points immediately (synchronous check)
  const redeemBtn = document.getElementById("redeemBtn")
  const canRedeem = (currentCustomer?.loyalty_points || 0) >= 10
  
  if (redeemBtn) {
    if (canRedeem) {
        redeemBtn.style.display = 'block'
        redeemBtn.disabled = false 
        redeemBtn.textContent = "Redeem Free Drink (10 pts)"
    } else {
        redeemBtn.style.display = 'none'
    }
  }
  
  // Check redemption status (async) to update state if pending
  checkActiveRedemption()
  
  // Render Stamp Card
  const stampGrid = document.getElementById("stampGrid")
  const stampsMessage = document.getElementById("stampsMessage")
  
  if (stampGrid) {
    stampGrid.innerHTML = ""
    
    // Calculate stamps: if at least 10 points, fill all 10; otherwise show current progress
    const stamps = points >= 10 ? 10 : points
    const freeDrinks = Math.floor(points / 10)
    const remainingPoints = points % 10
    
    if (stampsMessage) {
        if (freeDrinks > 0) {
            stampsMessage.textContent = `${stamps}/10 Stamps (You have ${freeDrinks} Free Drink${freeDrinks > 1 ? 's' : ''}!)`
        } else {
            stampsMessage.textContent = `${stamps}/10 Stamps`
        }
    }

    for (let i = 1; i <= 10; i++) {
        const slot = document.createElement("div")
        slot.className = "loyalty-stamp-slot"
        
        // 10th slot is special - gift icon
        if (i === 10) {
            slot.innerHTML = '<i class="fa-solid fa-gift"></i>'
            if (i <= stamps) {
                slot.classList.add("active")
            }
        } else {
            // Fill slots based on progress
            if (i <= stamps) {
                slot.classList.add("active")
                slot.innerHTML = '<i class="fa-solid fa-circle-dot"></i>'
            } else {
                slot.innerHTML = ''
            }
        }
        
        stampGrid.appendChild(slot)
    }
  }
  
  // Generate QR code
  if (window.QRCode) {
    const qrContainer = document.getElementById("qrCode")
    if (qrContainer) {
      qrContainer.innerHTML = "" // Clear previous
      window.QRCode.toCanvas(qrContainer, currentCustomer?.loyalty_card || "", { width: 200, margin: 2 }, (error) => {
        if (error) console.error(error)
      })
    }
  } else {
    console.error("QRCode library is not loaded")
  }
}


window.copyLoyaltyCard = () => {
  const cardDisplay = document.getElementById("loyaltyCardDisplay")
  if (cardDisplay && cardDisplay.textContent !== "--") {
    navigator.clipboard.writeText(cardDisplay.textContent).then(() => {
      const originalText = cardDisplay.textContent
      cardDisplay.style.backgroundColor = "#d4edda"
      setTimeout(() => {
        cardDisplay.style.backgroundColor = "#f0f0f0"
      }, 1000)
      showMessage("Copied to clipboard!", "success")
    }).catch(err => {
      console.error("Failed to copy:", err)
    })
  }
}

function viewLoyaltyHistory() {
  if (!currentCustomer) {
    showMessage("Register/Login first", "error")
    return
  }
  document.getElementById("loyaltyTable").style.display =
    document.getElementById("loyaltyTable").style.display === "none" ? "table" : "none"
}

// --- PROMOS ---
async function loadPromos() {
  const promoList = document.getElementById("promoList")
  if (!promoList) return

  if (!isDbReady()) {
    setTimeout(loadPromos, 500)
    return
  }

  // If cache is empty, fetch it once
  if (!allPromos || allPromos.length === 0) {
    const { data, error } = await db.from("promos").select("*").order("created_at", { ascending: false });
    if (!error && data) {
      allPromos = data;
    }
  }

  // Filter out expired promos (hide on the due date)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const activePromos = (allPromos || []).filter((p) => {
    if (!p.valid_until && !p.expires_at) return true; // No expiry date = always active
    const expiryDate = new Date(p.expires_at || p.valid_until);
    if (Number.isNaN(expiryDate.getTime())) return true;
    expiryDate.setHours(0, 0, 0, 0);
    return expiryDate >= today; // Keep promo visible through its valid_until date
  });

  if (activePromos.length === 0) {
    promoList.innerHTML = '<p style="text-align:center; color:#fff; padding: 50px;">No active promos/announcements at the moment.</p>'
    return
  }
  
  const fragment = document.createDocumentFragment()
  activePromos.forEach((d) => {
    const card = document.createElement("div")
    card.className = "promo-card-new"
    
    const dateStr = (d.expires_at || d.valid_until) ? new Date(d.expires_at || d.valid_until).toLocaleDateString() : 'Limited Time';
    const description = d.description || d.content || '';
    const codeDisplay = d.code && d.code.trim() !== "" ? `Code: ${d.code}` : "Exclusive Offer";

    card.innerHTML = `
      ${d.image_url ? `<img src="${d.image_url}" class="promo-image-new" alt="${d.title || 'Promo'}" loading="lazy" onerror="this.style.display='none'">` : ''}
      <div class="promo-info-new">
        <h3 class="promo-title-new">${d.title || "Untitled Promo"}</h3>
        <div class="promo-details-new">${description.replace(/\n/g, "<br>")}</div>
      </div>
      <div class="promo-footer-new">
        <span>${codeDisplay}</span>
        <span>Valid until: ${dateStr}</span>
      </div>
    `
    fragment.appendChild(card)
  })

  // Update DOM in one go using replaceChildren for stability
  promoList.replaceChildren(fragment)
}

// --- LOAD MENU ---
function loadMenu() {
  const menuList = document.getElementById("menuList")
  if (menuList) {
    menuList.innerHTML = '<p style="grid-column: 1/-1; padding: 50px; font-size: 18px; text-align:center; color:#fff;">Loading menu items...</p>'
  }

  if (!isDbReady()) {
    console.error("[v0] Attempting loadMenu but DB not ready")
    console.log("[v0] window.db:", window.db)
    showMessage("Database connecting... please refresh the page", "error", "custOrderMsg")
    wheelIsLoading = false
    loadMenuFallback("Database not ready")
    return
  }

  console.log("[v0] Loading menu from Supabase Products table...")
  db.from("products")
    .select("*")
    .then(({ data: products, error }) => {
      if (error) throw error;
      
      if (!products) products = [];
      products = products.map(normalizeProductRecord)
      products = products.filter((p) => p.archived !== true)
      allProducts = products // Store globally for other features
      wheelIsLoading = false

      products.sort((a, b) => {
        const ca = Number(a.category_id || 0)
        const cb = Number(b.category_id || 0)
        if (ca !== cb) return ca - cb
        const nameA = String(a.name || "")
          .trim()
          .toLowerCase()
        const nameB = String(b.name || "")
          .trim()
          .toLowerCase()
        if (nameA < nameB) return -1
        if (nameA > nameB) return 1
        return 0
      })

      if (products.length === 0) {
        loadMenuFallback("No products returned from database")
        return
      }

      groupedProducts = {}
      products.forEach((p) => {
        const catName =
          categories[Number(p.category_id)] ||
          p.category ||
          p.category_name ||
          p.categoryName ||
          "Uncategorized"
        if (!groupedProducts[catName]) groupedProducts[catName] = {}
        const prodName = String(p.name || "").trim() || "Unnamed"
        if (!groupedProducts[catName][prodName]) groupedProducts[catName][prodName] = []
        groupedProducts[catName][prodName].push(p)
      })

      const totalCount = products.length
      console.log("[v0] Successfully loaded " + totalCount + " products")
      if (totalCount === 0) {
        console.warn("[v0] No products found in database")
        showMessage("No products available - check database", "error", "custOrderMsg")
      }
      renderMenu("All")
      
      // Update preorder menu when menu data is loaded
      if (typeof renderPreorderMenu === 'function') {
         console.log("[v0] Menu loaded, refreshing preorder menu")
         renderPreorderMenu(currentPreorderCategory)
      }

      // Refresh spin wheel if we are on that page
      if (window.__customerCurrentPage === 'spin' && typeof updateWheel === 'function') {
        console.log("[v0] Data loaded, refreshing spin wheel items")
        updateWheel()
      }
    })
    .catch((error) => {
      console.error("[v0] Menu load failed:", error.code, error.message)
      wheelIsLoading = false
      showMessage("Failed to load menu: " + error.message, "error", "custOrderMsg")
      loadMenuFallback(error.message || "Menu load failed")
    })
}

function loadMenuFallback(reason = "Fallback menu") {
  const menuList = document.getElementById("menuList")
  if (menuList) {
    menuList.innerHTML = `<p style="grid-column: 1/-1; padding: 50px; font-size: 18px; text-align:center; color:#fff;">No menu items available. ${reason}</p>`
  }
  const preorderList = document.getElementById("preorderMenuGrid")
  if (preorderList) preorderList.innerHTML = `<p style="text-align:center; color:red;">No menu items available.</p>`
  if (window.__customerCurrentPage === "spin" && typeof setWheelStatus === "function") {
    setWheelStatus("Menu unavailable", "Please try again later.", true)
  }
}

window.searchMenu = (query) => {
  currentMenuSearch = (query || "").trim().toLowerCase()
  // Debounce to prevent lag while typing
  if (window.__menuSearchTimer) clearTimeout(window.__menuSearchTimer)
  window.__menuSearchTimer = setTimeout(() => {
    renderMenu(currentMenuCategory)
  }, 180)
}

function renderMenu(category) {
  const menuList = document.getElementById("menuList")
  if (!menuList) return
  menuList.replaceChildren()

  const categoryOrder = ["Coffee", "Non-coffee", "Frappe", "Soda", "Pastries", "Uncategorized"]
  const cats = categoryOrder
    .filter((c) => groupedProducts[c])
    .concat(Object.keys(groupedProducts).filter((c) => !categoryOrder.includes(c)))

  if (cats.length === 0) {
    menuList.innerHTML = '<p style="grid-column: 1/-1; padding: 50px; font-size: 18px; text-align:center; color:#fff;">No menu items available.</p>'
    return
  }

  const frag = document.createDocumentFragment()

  cats.forEach((catName) => {
    if (category !== "All" && category !== catName) return

    const entries = Object.entries(groupedProducts[catName] || {})
    .filter(([prodName]) => {
        if (!currentMenuSearch) return true
        return prodName.toLowerCase().includes(currentMenuSearch)
    })
    .sort((a, b) => a[0].localeCompare(b[0]))

    if (entries.length > 0 && category === "All") {
      const header = document.createElement("div")
      header.className = "category-header"
      let icon = catName.includes("Coffee") ? "&#9749;" : catName.includes("Non-coffee") ? "&#129380;" : catName.includes("Frappe") ? "&#127848;" : catName.includes("Soda") ? "&#129380;" : catName.includes("Pastries") ? "&#129360;" : "";
      header.innerHTML = `<span>${icon}</span> ${catName}`
      frag.appendChild(header)
    }

    entries.forEach(([prodName, sizesArr]) => {
      const sizes = [...sizesArr].sort((p1, p2) => Number(p1.id || 0) - Number(p2.id || 0))
      const card = document.createElement("div")
      card.className = "menu-card"

      const basePhoto = sizes[0].image_url || "../images/tori.jpg"
      
      card.innerHTML = `
        <img src="${basePhoto}" alt="${prodName}" onerror="this.src='../images/tori.jpg'">
        <div class="menu-card-overlay">
          <div class="menu-card-name">${prodName}</div>
          <div class="view-details-btn">View Details</div>
        </div>
      `
      
      card.onclick = () => openItemModal(prodName, sizes, catName)
      frag.appendChild(card)
    })
  })

  menuList.appendChild(frag)
}

let currentModalItem = null
let selectedModalSize = null
let selectedModalTemp = 'Hot'

function openItemModal(name, sizes, catName) {
  currentModalItem = { name, sizes, catName }
  selectedModalSize = sizes[0]
  selectedModalTemp = 'Hot'
  
  document.getElementById('modalTitle').textContent = name
  // Use admin description if available
  const adminDesc = sizes[0].description || sizes[0].product_description || ""
  document.getElementById('modalDesc').textContent = adminDesc
  document.getElementById('modalImg').style.backgroundImage = `url('${sizes[0].image_url || '../images/tori.jpg'}')`
  
  // Temperature section - only for Coffee
  const isCoffee = catName === 'Coffee'
  document.getElementById('modalTempSection').style.display = isCoffee ? 'block' : 'none'
  
  // Sizes grid
  const sizeGrid = document.getElementById('modalSizeGrid')
  sizeGrid.innerHTML = ''
  sizes.forEach((s, idx) => {
    const btn = document.createElement('div')
    btn.className = 'modal-size-btn' + (idx === 0 ? ' active' : '')
    if (s.is_available === false) {
      btn.classList.add('disabled')
      btn.innerHTML = `
        <span class="size-name">${s.size}</span>
        <span class="size-price">Sold Out</span>
      `
    } else {
      btn.innerHTML = `
        <span class="size-name">${s.size}</span>
        <span class="size-price">₱${Number(s.price || s.product_price || 0).toFixed(2)}</span>
      `
      btn.onclick = () => {
        document.querySelectorAll('.modal-size-btn').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        selectedModalSize = s
      }
    }
    sizeGrid.appendChild(btn)
  })
  
  document.getElementById('itemModal').style.display = 'flex'
  document.body.style.overflow = 'hidden'
}

function closeItemModal() {
  const modal = document.getElementById('itemModal')
  if (modal) modal.style.display = 'none'
  document.body.style.overflow = 'auto'
}

function setModalTemp(temp) {
  selectedModalTemp = temp
  document.querySelectorAll('.modal-temp-btn').forEach(b => b.classList.remove('active'))
  if (temp === 'Cold') document.getElementById('tempCold').classList.add('active')
  else document.getElementById('tempHot').classList.add('active')
}

function handleModalAdd() {
  if (!selectedModalSize || selectedModalSize.is_available === false) return
  
  const price = Number(selectedModalSize.price || selectedModalSize.product_price || 0)
  const photo = selectedModalSize.image_url || currentModalItem.sizes[0].image_url || ""
  const temperature = currentModalItem.catName === "Coffee" ? selectedModalTemp : null
  
  if (typeof addToOrder === 'function') {
    addToOrder(selectedModalSize.id, currentModalItem.name, price, photo, temperature)
    closeItemModal()
  }
}

// --- KIOSK ORDER LOGIC ---

// Helper functions for order management
function updateOrderQty(idx, delta) {
  if (!kioskOrder[idx]) return
  
  const item = kioskOrder[idx]
  const newQty = Number(item.qty || 0) + delta
  
  if (newQty <= 0) {
    removeOrderItem(idx)
  } else {
    item.qty = newQty
    renderKioskOrder()
  }
}

function removeOrderItem(idx) {
  if (idx >= 0 && idx < kioskOrder.length) {
    kioskOrder.splice(idx, 1)
    renderKioskOrder()
  }
}

// Expose to window for debugging if needed, but internal logic uses direct references
window.custQty = updateOrderQty
window.custRemove = removeOrderItem

function addToOrder(id, name, price, photo, temperature = null) {
  if (isGuest) {
    showMessage("Please sign in to place an order.", "error", "custOrderMsg")
    return
  }
  console.log("[v0] Adding to order:", name, price, temperature)
  const itemKey = temperature ? `${id}-${temperature}` : id
  const displayName = temperature ? `${name} (${temperature})` : name
  const existing = kioskOrder.find((i) => i.product_id === id && i.name === displayName)
  if (existing) {
    existing.qty = Number(existing.qty || 0) + 1
  } else {
    kioskOrder.push({ product_id: id, name: displayName, price, qty: 1, photo })
  }
  
  // Auto-open drawer if it's the first item
  if (kioskOrder.length === 1) {
    const drawer = document.getElementById("orderDrawer")
    const btn = document.getElementById("orderDrawerBtn")
    if (drawer) drawer.classList.add("active")
    if (btn) btn.classList.add("active")
    document.body.classList.add("drawer-open")
  }
  
  showCartToast();
  renderKioskOrder()
}

function renderKioskOrder() {
  const container = document.getElementById("cartItemsContainer")
  const totalEl = document.getElementById("custOrderTotal")
  const subtotalEl = document.getElementById("cartSubtotal")
  const vatEl = document.getElementById("cartVat")
  const countBadge = document.getElementById("orderCartBadge")
  const drawerBtn = document.getElementById("orderDrawerBtn")
  const emptyMsg = document.getElementById("emptyCartMessage")
  
  if (!container || !totalEl) return
  
  container.innerHTML = ""
  let total = 0
  let itemCount = 0
  
  if (kioskOrder.length === 0) {
    if (emptyMsg) emptyMsg.style.display = "block"
    totalEl.textContent = "0.00"
    if (subtotalEl) subtotalEl.textContent = "0.00"
    if (vatEl) vatEl.textContent = "0.00"
  } else {
    if (emptyMsg) emptyMsg.style.display = "none"
    
    kioskOrder.forEach((item, idx) => {
      const qty = Number(item.qty || 0)
      const price = Number(item.price || 0)
      const t = qty * price
      total += t
      itemCount += qty
      
      const card = document.createElement("div")
      card.className = "cart-item-card"
      
      const photo = item.photo || item.image_url || ""
      const imgHtml = photo 
        ? `<img src="${photo}" class="cart-item-img" alt="${item.name}">`
        : `<div class="cart-item-img-placeholder">☕</div>`
        
      card.innerHTML = `
        ${imgHtml}
        <div class="cart-item-info">
          <div class="cart-item-name">${item.name}</div>
          <div class="cart-item-variant">${item.size || ""} ${item.temp ? `(${item.temp})` : ""}</div>
          <div class="cart-item-price">₱${price.toFixed(2)}</div>
        </div>
        <div class="cart-item-actions">
          <div class="cart-qty-controls">
            <button class="cart-qty-btn" onclick="updateOrderQty(${idx}, -1)">−</button>
            <span class="cart-qty-val">${qty}</span>
            <button class="cart-qty-btn" onclick="updateOrderQty(${idx}, 1)">+</button>
          </div>
          <div class="cart-item-subtotal">₱${t.toFixed(2)}</div>
          <button class="cart-remove-btn" onclick="removeOrderItem(${idx})" title="Remove item">✕</button>
        </div>
      `
      container.appendChild(card)
    })
    
    const subtotal = total / 1.12
    const vat = total - subtotal
    
    totalEl.textContent = total.toFixed(2)
    if (subtotalEl) subtotalEl.textContent = subtotal.toFixed(2)
    if (vatEl) vatEl.textContent = vat.toFixed(2)
  }

  if (countBadge && drawerBtn) {
    if (itemCount > 0) {
      countBadge.textContent = String(itemCount)
      drawerBtn.classList.add("has-items")
    } else {
      countBadge.textContent = ""
      drawerBtn.classList.remove("has-items")
    }
  }
}

// --- PAYMENT FUNCTIONS ---

async function loadPaymentSettings() {
    try {
        const { data, error } = await db.from("settings").select("value").eq("key", "admin_qr_code").single()
        if (error && error.code !== 'PGRST116') console.warn("Error loading payment settings:", error)
        
        if (data) {
            adminQrUrl = data.value
            const displays = ["customerQrDisplay", "preorderQrDisplay", "repayQrDisplay"]
            const placeholders = ["customerQrPlaceholder", "preorderQrPlaceholder", "repayQrPlaceholder"]
            
            displays.forEach((id, idx) => {
                const img = document.getElementById(id)
                const placeholder = document.getElementById(placeholders[idx])
                if (img) {
                    img.src = adminQrUrl
                    if (adminQrUrl) {
                        img.style.display = "block"
                        if (placeholder) placeholder.style.display = "none"
                    }
                }
            })
        }
    } catch (err) {
        console.error("Exception loading payment settings:", err)
    }
}

// --- CHECKOUT ---
function openPaymentModal() {
    console.log("[v0] openPaymentModal triggered");
    try {
        const msg = document.getElementById("custOrderMsg")
        
        // Check if cart has items
        if (!kioskOrder || !kioskOrder.length) {
            console.warn("[v0] kioskOrder empty or length is 0", kioskOrder);
            if (msg) {
                msg.textContent = "Add items first"
                msg.className = "error"
                setTimeout(() => (msg.textContent = ""), 2000)
            }
            return
        }
        
        console.log("[v0] Proceeding with checkout for", kioskOrder.length, "items");

        // Close drawers first
        if (typeof closeOrderDrawer === "function") {
            console.log("[v0] Calling closeOrderDrawer");
            closeOrderDrawer();
        }
        if (typeof closePreorderDrawer === "function") {
            console.log("[v0] Calling closePreorderDrawer");
            closePreorderDrawer();
        }

        // Show the payment modal
        const modal = document.getElementById("paymentModal")
        if (modal) {
            console.log("[v0] Setting paymentModal display to flex");
            modal.style.display = "flex"
            modal.style.visibility = "visible"
            modal.style.opacity = "1"
        } else {
            console.error("[v0] CRITICAL: paymentModal element not found in DOM");
            alert("Error: Payment system is currently unavailable. Please refresh.");
        }
        
        // Reset payment method to default (Cash)
        selectedPaymentMethod = "cash"
        const radios = document.getElementsByName("paymentMethod")
        if (radios.length) {
            radios[0].checked = true
        }
        
        // Sync UI for the selected method
        if (typeof togglePaymentDetails === "function") {
            togglePaymentDetails();
        }
    } catch (err) {
        console.error("[v0] Exception in openPaymentModal:", err);
    }
}
window.openPaymentModal = openPaymentModal

// Global failsafe listener
document.addEventListener("click", (e) => {
    const target = e.target.closest("#checkoutNowBtn");
    if (target) {
        console.log("[v0] checkoutNowBtn clicked via global listener");
        openPaymentModal();
    }
});

window.closePaymentModal = () => {
    const modal = document.getElementById("paymentModal")
    if (modal) modal.style.display = "none"
}

window.togglePaymentDetails = () => {
    const radios = document.getElementsByName("paymentMethod")
    let val = "cash"
    for (const r of radios) { if (r.checked) val = r.value }
    selectedPaymentMethod = val
    
    const onlineDiv = document.getElementById("paymentDetailsOnline")
    const cashDiv = document.getElementById("paymentDetailsCash")
    
    if (val === "online") {
        if (onlineDiv) onlineDiv.style.display = "block"
        if (cashDiv) cashDiv.style.display = "none"
    } else {
        if (onlineDiv) onlineDiv.style.display = "none"
        if (cashDiv) cashDiv.style.display = "block"
    }
}

window.togglePreorderPayment = () => {
    const radios = document.getElementsByName("preorderPaymentMethod")
    let val = "cash"
    for (const r of radios) { if (r.checked) val = r.value }
    preorderPaymentMethod = val
    
    const onlineDiv = document.getElementById("preorderPaymentOnline")
    if (val === "online") {
        if (onlineDiv) onlineDiv.style.display = "block"
    } else {
        if (onlineDiv) onlineDiv.style.display = "none"
    }
}

window.confirmPaymentAndOrder = async () => {
    const msg = document.getElementById("paymentMessage")
    if (msg) msg.textContent = ""
    
    showMessage("Order in Process...", "info", "paymentMessage")

    if (!isDbReady()) {
        if (msg) {
            msg.textContent = "Database connecting... please try again"
            msg.className = "error"
        }
        return
    }
    
    let proofUrl = null
    
    if (selectedPaymentMethod === "online") {
        const fileInput = document.getElementById("paymentProof")
        const file = fileInput?.files[0]
        
        if (!file) {
            if (msg) {
                msg.textContent = "Please attach proof of payment (receipt)."
                msg.className = "error"
            }
            return
        }

        // Point 1: Validate resolution
        try {
            await validateReceiptResolution(file)
        } catch (resErr) {
            if (msg) {
                msg.textContent = resErr
                msg.className = "error"
            }
            return
        }
        
        // Upload
        const btn = document.querySelector("#paymentModal .btn-primary")
        if (btn) {
            btn.disabled = true
            btn.textContent = "Uploading..."
        }
        
        try {
            const timestamp = Date.now()
            const fileName = `proof_kiosk_${timestamp}_${Math.random().toString(36).substring(2, 7)}`
            const { data, error } = await db.storage.from('product-photos').upload(fileName, file)
            
            if (error) throw error
            
            const { data: { publicUrl } } = db.storage.from('product-photos').getPublicUrl(fileName)
            proofUrl = publicUrl
            
        } catch (err) {
            console.error("Upload error:", err)
            if (msg) {
                msg.textContent = "Upload failed: " + err.message
                msg.className = "error"
            }
            if (btn) {
                btn.disabled = false
                btn.textContent = "Confirm Order"
            }
            return
        }
    }
    
    // Proceed to place order (with recovery on error)
    const btn = document.querySelector("#paymentModal .btn-primary")
    if (btn) {
        btn.disabled = true
        btn.textContent = "Placing order..."
    }
    
    try {
        await placeKioskOrder({
            payment_method: selectedPaymentMethod,
            proof_of_payment: proofUrl
        })
        window.closePaymentModal()
    } catch (err) {
        console.error("Order submit error:", err)
        const m = err && err.message ? err.message : String(err || "Unknown error")
        if (msg) {
            msg.textContent = "Order failed. Auto-refreshing… " + m
            msg.className = "error"
        }
        // Handling protocol: refresh critical views so user can try again safely
        try { loadMenu() } catch (_) {}
        try { runTrackOrder && runTrackOrder() } catch (_) {}
        // Keep modal open so they can retry without losing context
        return
    } finally {
        if (btn) {
            btn.disabled = false
            btn.textContent = "Confirm Order"
        }
    }
}

window.openRepayModal = (source, orderId, remainingAmount, notificationId) => {
    repayContext = {
        source: source || "bookings",
        orderId,
        remaining: Number(remainingAmount || 0),
        notificationId: notificationId || null
    }
    const info = document.getElementById("repayOrderInfo")
    if (info) {
        info.textContent = `Order #${orderId} - Remaining Balance: \u20B1 ${Number(repayContext.remaining || 0).toFixed(2)}`
    }
    const modal = document.getElementById("repayModal")
    if (modal) modal.style.display = "flex"
    repayPaymentMethod = "online"
    const radios = document.getElementsByName("repayPaymentMethod")
    if (radios.length) {
        for (const r of radios) {
            r.checked = r.value === "online"
        }
    }
    const msg = document.getElementById("repayMessage")
    if (msg) msg.textContent = ""
    const fileInput = document.getElementById("repayProof")
    if (fileInput) fileInput.value = ""
    const warning = document.getElementById("repayProofWarning")
    if (warning) warning.style.display = "none"
    toggleRepayDetails()
}

window.closeRepayModal = () => {
    const modal = document.getElementById("repayModal")
    if (modal) modal.style.display = "none"
    repayContext = null
}

window.toggleRepayDetails = () => {
    const radios = document.getElementsByName("repayPaymentMethod")
    let val = "online"
    for (const r of radios) { if (r.checked) val = r.value }
    repayPaymentMethod = val
    const onlineDiv = document.getElementById("repayDetailsOnline")
    const cashDiv = document.getElementById("repayDetailsCash")
    if (val === "online") {
        if (onlineDiv) onlineDiv.style.display = "block"
        if (cashDiv) cashDiv.style.display = "none"
    } else {
        if (onlineDiv) onlineDiv.style.display = "none"
        if (cashDiv) cashDiv.style.display = "block"
    }
}

window.confirmRepay = async () => {
    const msg = document.getElementById("repayMessage")
    if (msg) msg.textContent = ""
    if (!repayContext) return
    if (!isDbReady()) {
        if (msg) {
            msg.textContent = "Database connecting... please try again"
            msg.className = "error"
        }
        return
    }

    const table = repayContext.source === "pending_orders" ? "pending_orders" : "bookings"
    let proofUrl = null

    if (repayPaymentMethod === "online") {
        const fileInput = document.getElementById("repayProof")
        const file = fileInput?.files[0]
        if (!file) {
            if (msg) {
                msg.textContent = "Please attach proof of payment (receipt)."
                msg.className = "error"
            }
            return
        }

        // Point 1: Validate resolution
        try {
            await validateReceiptResolution(file)
        } catch (resErr) {
            if (msg) {
                msg.textContent = resErr
                msg.className = "error"
            }
            return
        }

        const btn = document.querySelector("#repayModal .btn-primary")
        if (btn) {
            btn.disabled = true
            btn.textContent = "Uploading..."
        }

        try {
            const timestamp = Date.now()
            const fileName = `proof_repay_${timestamp}_${Math.random().toString(36).substring(2, 7)}`
            const { error } = await db.storage.from('product-photos').upload(fileName, file)
            if (error) throw error
            const { data: { publicUrl } } = db.storage.from('product-photos').getPublicUrl(fileName)
            proofUrl = publicUrl
        } catch (err) {
            console.error("Upload error:", err)
            if (msg) {
                msg.textContent = "Upload failed: " + err.message
                msg.className = "error"
            }
            const btn = document.querySelector("#repayModal .btn-primary")
            if (btn) {
                btn.disabled = false
                btn.textContent = "Submit Payment"
            }
            return
        }
    }

    try {
        const { data: order } = await db.from(table).select("*").eq("id", repayContext.orderId).single()
        const remaining = Number(repayContext.remaining || 0)
        const paymentLog = formatPaymentLogEntry(remaining, 0)
        const baseNote = `Repayment completed (${repayPaymentMethod}).`
        const detailNote = repayPaymentMethod === "cash"
            ? "Customer paid remaining in cash."
            : "Customer uploaded repayment proof."
        const existing = order?.insufficient_notes || order?.notes || ""
        let combined = appendPaymentLog(existing, paymentLog)
        combined = appendPaymentLog(combined, baseNote)
        combined = appendPaymentLog(combined, detailNote)

        const payload = {
            // Keep insufficient_payment true until cashier confirms
            insufficient_payment: true, 
            second_payment_status: "pending_verification",
            second_payment_method: repayPaymentMethod,
            insufficient_notes: combined,
            notes: combined,
            payment_status: "pending_verification"
        }
        if (proofUrl) payload.second_payment_proof = proofUrl

        await safeUpdateRow(table, repayContext.orderId, payload)
        // Update the customer notification to reflect submission
        if (repayContext.notificationId && !String(repayContext.notificationId).startsWith("fallback-")) {
            await db.from("customer_notifications")
              .update({ status: "pending_verification", updated_at: new Date().toISOString() })
              .eq("id", repayContext.notificationId)
        }

        if (msg) {
            msg.textContent = "Payment submitted for verification. Please wait for the cashier to confirm.";
            msg.className = "success";
        }
        setTimeout(() => window.closeRepayModal(), 2000);
        fetchCustomerNotifications({ autoOpen: false }).catch(() => {})
        runTrackOrder().catch(console.error)
    } catch (err) {
        console.error("Repay update failed:", err)
        if (msg) {
            msg.textContent = "Failed to submit repayment: " + (err.message || err)
            msg.className = "error"
        }
    } finally {
        const btn = document.querySelector("#repayModal .btn-primary")
        if (btn) {
            btn.disabled = false
            btn.textContent = "Submit Payment"
        }
    }
}

async function placeKioskOrder(paymentDetails = {}) {
  if (isOrderSubmitting) {
    console.warn("Order submission already in progress")
    return
  }
  
  if (isGuest) {
    if (msg) {
      msg.textContent = "Guest mode is view-only. Please sign in to place an order."
      msg.className = "error"
      setTimeout(() => (msg.textContent = ""), 2500)
    }
    return
  }
  
  // Determine message container
  const isPaymentModal = document.getElementById("paymentModal")?.style.display === "flex"
  const msgContainerId = isPaymentModal ? "paymentMessage" : "custOrderMsg"
  const msg = document.getElementById(msgContainerId)
  
  if (!kioskOrder.length) {
    if (msg) {
      msg.textContent = "Add items first"
      msg.className = "error"
      setTimeout(() => (msg.textContent = ""), 2000)
    }
    return
  }
  
  // Check active kiosk order limit (max 2)
  try {
    const customerId = currentCustomer?.contact || currentCustomer?.email
    let pendingQuery = db.from("pending_orders")
      .select("*")
      .neq("type", "redemption")
      .in("status", ["pending", "ACCEPTED", "INSUFFICIENT", "preparing", "ready", "accepted", "insufficient", "for_pickup"])
    
    const buildIdentityFilter = (query) => {
      if (!customerId) return query
      const e = String(customerId).replace(/'/g, "''")
      return query.or(`customer_id.eq."${e}",customer_id.ilike."%${e}%"`)
    }
    pendingQuery = buildIdentityFilter(pendingQuery)
    
    const { data: pendingOrders, error: pendingError } = await pendingQuery
    if (pendingError) throw pendingError
    
    const activeKioskOrders = (pendingOrders || []).filter(order => 
      order.type === "kiosk" && 
      order.status !== "completed" && 
      order.status !== "rejected" && 
      order.status !== "cancelled"
    )
    
    if (activeKioskOrders.length >= 2) {
      isOrderSubmitting = false
      const processingModal = document.getElementById("processingModal");
      if (processingModal) processingModal.style.display = "none";
      if (msg) msg.textContent = ""
      
      window.openLimitedTransactionsModal()
      return
    }
  } catch (err) {
    console.error("Error checking active kiosk orders:", err)
    isOrderSubmitting = false
    const processingModal = document.getElementById("processingModal");
    if (processingModal) processingModal.style.display = "none";
    
    window.openLimitedTransactionsModal()
    return
  }
  
  const items = kioskOrder.map((i) => ({
    id: i.product_id || i.id || "",
    name: i.name || "Unknown",
    category_id: i.category_id || null,
    quantity: Number(i.qty || 1),
    price: Number(i.price || 0),
  }))
  
  const total = kioskOrder.reduce((s, i) => s + (Number(i.price) * Number(i.qty)), 0)
  const payload = { 
      customer_id: currentCustomer?.contact || currentCustomer?.email || "GUEST", 
      items, 
      total 
  }
  
  // Include loyalty card if customer is logged in
  const loyaltyCard = currentCustomer?.loyalty_card || null
  
  isOrderSubmitting = true
  const processingModal = document.getElementById("processingModal");
  if (processingModal) processingModal.style.display = "flex";
  if (msg) msg.textContent = "Placing order..."
  
  try {
      const { error } = await db
        .from("pending_orders")
        .insert([{
          customer_id: payload.customer_id,
          // kiosk_id: payload.kiosk_id, // Removed as column doesn't exist
          items: JSON.stringify(payload.items), // Ensure JSON format
          total: payload.total,
          status: "pending",
          type: "kiosk",
          loyalty_card: loyaltyCard,
          timestamp: new Date().toISOString(), // Use ISO string for timestamptz
          payment_method: paymentDetails.payment_method || 'cash',
          proof_of_payment: paymentDetails.payment_method === 'online' ? paymentDetails.proof_of_payment : null
        }])

      if (error) throw error;

      isOrderSubmitting = false
      
      // Delay closing to let user see the processing state
      setTimeout(() => {
        const title = document.getElementById("processingModalTitle");
        const text = document.getElementById("processingModalText");
        const spinner = document.querySelector("#processingModal .processing-spinner");
        
        if (title) title.textContent = "Order Sent!";
        if (text) text.textContent = "Your order has been successfully placed.";
        if (spinner) spinner.style.display = "none";

        setTimeout(() => {
          if (processingModal) processingModal.style.display = "none";
          // Reset for next time
          if (title) title.textContent = "Order is on process";
          if (text) text.textContent = "Please wait while we handle your request...";
          if (spinner) spinner.style.display = "block";
          
          kioskOrder = []
          renderKioskOrder()
          if (msg) {
              msg.textContent = "Order placed! Please wait for confirmation."
              msg.className = "success"
              setTimeout(() => (msg.textContent = ""), 2500)
          }
          
          // Close drawer when placing order (if function exists)
          if (typeof closeOrderDrawer === 'function') {
              closeOrderDrawer() 
          } else {
              // Fallback if function not defined
              const drawer = document.getElementById("orderDrawer")
              const btn = document.getElementById("orderDrawerBtn")
              if (drawer) drawer.classList.remove("active")
              if (btn) btn.classList.remove("active")
              document.body.classList.remove("drawer-open")
          }
        }, 2500);
      }, 1000);
  } catch (err) {
      console.error("Order placement failed:", err)
      isOrderSubmitting = false
      const processingModal = document.getElementById("processingModal");
      
      setTimeout(() => {
        if (processingModal) processingModal.style.display = "none";
        if (msg) {
            msg.textContent = "Order failed: " + err.message
            msg.className = "error"
            setTimeout(() => (msg.textContent = ""), 3000)
        }
      }, 1000);
  }
}

async function runTrackOrder() {
  const orderBody = document.getElementById("trackBody")
  const historyBody = document.getElementById("historyBody")
  const bookingBody = document.getElementById("bookingBody")
  const syncStatus = document.getElementById("trackSyncStatus")
  
  if (!currentCustomer) return

  // Update sync status indicator
  if (syncStatus) {
      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      syncStatus.innerHTML = `<span class="sync-dot" style="width: 8px; height: 8px; background: #4caf50; border-radius: 50%; display: inline-block;"></span> Last synced: ${now}`
  }

  const parseInsufficientAmountFromNotes = (text) => {
    const safeText = String(text || "")
    if (!safeText) return 0
    if (/\bpayment confirmed at\b/i.test(safeText) || /\-\s*paid\b/i.test(safeText)) return 0
    let match = safeText.match(/remaining balance[:\s]*[^\d]*([\d,.]+)\b/i)
    if (!match) match = safeText.match(/still needed[:\s]*[^\d]*([\d,.]+)\b/i)
    if (!match && /insufficient/i.test(safeText)) {
      match = safeText.match(/(?:\u20B1|PHP|\u00E2\u201A\u00B1)?\s*([\d,.]+)\b/i)
    }
    if (!match) return 0
    const raw = String(match[1] || match[2] || "").replace(/,/g, "")
    const value = Number(raw)
    return Number.isFinite(value) ? value : 0
  }

  const resolveInsufficientInfo = (d) => {
    const notesText = String(d.insufficient_notes || d.notes || "")
    const paidMarker = /\bpayment confirmed at\b/i.test(notesText) || /\-\s*paid\b/i.test(notesText)
    const fromColumn = Number(d.insufficient_amount_needed || 0)
    const parsed = parseInsufficientAmountFromNotes(notesText)
    const stillNeeded = fromColumn > 0 ? fromColumn : (parsed > 0 ? parsed : 0)
    const hasMarker = !paidMarker && (d.insufficient_payment === true || stillNeeded > 0 || /insufficient/i.test(notesText))
    return { hasMarker, stillNeeded, notesText }
  }
  
  const email = currentCustomer.email
  const contact = currentCustomer.contact
  
  // Helper to build OR filter for customer identity
  const buildIdentityFilter = (query) => {
    // Escape single quotes for filter string if any
    const e = String(email || "").replace(/'/g, "''")
    const c = String(contact || "").replace(/'/g, "''")

    if (e && c) {
      return query.or(`customer_id.eq."${e}",customer_id.eq."${c}",customer_id.ilike."%${e}%",customer_id.ilike."%${c}%"`)
    } else if (e) {
      return query.or(`customer_id.eq."${e}",customer_id.ilike."%${e}%"`)
    } else if (c) {
      return query.or(`customer_id.eq."${c}",customer_id.ilike."%${c}%"`)
    }
    return query
  }

  let activeOrders = []
  let historyOrdersData = []
  let bookingsData = []
  let rescheduleLogs = []
  let allPendingOrders = []

  try {
      // 1. Fetch pending orders
      let pendingQuery = db.from("pending_orders").select("*").neq("type", "redemption")
      pendingQuery = buildIdentityFilter(pendingQuery)
      const { data: pData, error: pError } = await pendingQuery
      
      if (pError) throw pError
      allPendingOrders = pData || []

      // 2. Fetch history orders
      let historyQuery = db.from("orders").select("*")
      historyQuery = buildIdentityFilter(historyQuery)
      const { data: hData, error: hError } = await historyQuery
      
      if (hError) throw hError
      historyOrdersData = (hData || []).filter(it => it.is_redemption !== true)

      // 3. Fetch bookings FIRST (so we can use it for activeOrders)
      let bookingsQuery = db.from("bookings").select("*")
      bookingsQuery = buildIdentityFilter(bookingsQuery)
      const { data: bData, error: bError } = await bookingsQuery
      
      if (bError) throw bError
      bookingsData = bData || []
      const allBookings = (bookingsData || []).map(doc => ({ ...doc }))

      activeOrders = [
        ...allPendingOrders.filter(o => 
            o.status !== 'completed' && o.status !== 'rejected' && o.status !== 'cancelled'
        ),
        ...allBookings.filter(b => 
            b.type === 'preorder' && 
            b.status !== 'completed' && b.status !== 'rejected' && b.status !== 'cancelled'
        )
      ]

      // 4. Fetch reschedule logs if needed
      if (bookingsData.length > 0) {
          const bookingIds = bookingsData.map(b => b.id)
          const { data: logs, error: logErr } = await db.from("booking_reschedule_logs").select("*").in("booking_id", bookingIds)
          if (!logErr) rescheduleLogs = logs || []
      }

      // Process and Render
      const historyGroups = {}
      
      // Group history items
      historyOrdersData.forEach(item => {
          const ts = item.created_at || item.timestamp
          if (!ts) return
          const key = new Date(ts).toISOString().split('.')[0] + 'Z' 
          if (!historyGroups[key]) {
              historyGroups[key] = {
                  timestamp: ts,
                  items: [],
                  total: 0,
                  status: item.status || 'completed',
                  rejection_reason: item.rejection_reason || item.rejectionReason || item.insufficient_notes || item.notes || ""
              }
          }
          historyGroups[key].items.push(item)
          historyGroups[key].total += (Number(item.price || 0) * Number(item.quantity || 1))
      })

      // Add terminal states from pending_orders to history
      allPendingOrders.forEach(order => {
          if (['completed', 'rejected', 'cancelled'].includes(order.status)) {
              const ts = order.created_at || order.timestamp
              if (!ts) return
              const key = new Date(ts).toISOString().split('.')[0] + 'Z'
              if (!historyGroups[key]) {
                  let items = order.items
                  if (typeof items === 'string') try { items = JSON.parse(items) } catch(e) { items = [] }
                  historyGroups[key] = {
                      timestamp: ts,
                      items: (items || []).map(i => ({ ...i, quantity: i.qty || i.quantity })),
                      total: order.total,
                      status: order.status,
                      rejection_reason: order.rejection_reason || order.rejectionReason || order.insufficient_notes || order.notes || ""
                  }
              }
          }
      })

      // Separate active and history bookings
      const activeBookingsSection = allBookings.filter(b => ['pending', 'accepted', 'preparing', 'ready'].includes(b.status))
      const bookingHistory = allBookings.filter(b => ['completed', 'rejected', 'cancelled'].includes(b.status))

      // Add booking history to historyGroups
      bookingHistory.forEach(booking => {
          const ts = booking.created_at || booking.timestamp
          if (!ts) return
          const key = new Date(ts).toISOString().split('.')[0] + 'Z'
          if (!historyGroups[key]) {
              let items = booking.items
              if (typeof items === 'string') try { items = JSON.parse(items) } catch(e) { items = [] }
              historyGroups[key] = {
                  timestamp: ts,
                  items: (items || []).map(i => ({ ...i, quantity: i.qty || i.quantity })),
                  total: booking.total || 0,
                  status: booking.status,
                  rejection_reason: booking.rejection_reason || booking.rejectionReason || booking.insufficient_notes || booking.notes || "",
                  is_booking: true,
                  booking_type: booking.type
              }
          }
      })

      // Final sorting
      activeOrders.sort((a, b) => new Date(b.created_at || b.timestamp || 0) - new Date(a.created_at || a.timestamp || 0))
      
      const historyOrders = Object.values(historyGroups)
        .filter(hOrder => !activeOrders.some(aOrder => Math.abs(new Date(hOrder.timestamp).getTime() - new Date(aOrder.created_at || aOrder.timestamp).getTime()) < 2000))
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))

      const mapOrderStatus = (status, currentlyPreparing, isPaid, hasInsufficientMarker, paidMarker) => {
        const s = String(status || "").toLowerCase()
        if (['completed', 'complete', 'done'].includes(s)) return "Complete"
        if (['ready', 'for_pickup', 'for pickup'].includes(s)) return "For Pickup"
        if (currentlyPreparing || s === 'preparing' || s === 'accepted' || paidMarker) return "Preparing"
        if (hasInsufficientMarker) return "Preparing"
        if (s === 'pending' || isPaid) return "In Process"
        if (s === 'rejected') return "Rejected"
        if (s === 'cancelled') return "Cancelled"
        return "In Process"
      }

      const getBadgeStyle = (displayStatus) => {
        if (displayStatus === "In Process") return "background:#fff3e0;color:#e65100;font-weight:700;"
        if (displayStatus === "Preparing") return "background:#f3e5f5;color:#7b1fa2;font-weight:700;"
        if (displayStatus === "For Pickup") return "background:#4CAF50;color:white;font-weight:700;"
        if (displayStatus === "Complete") return "background:#9E9E9E;color:white;"
        if (displayStatus === "Rejected") return "background:#f44336;color:white;"
        if (displayStatus === "Cancelled") return "background:#757575;color:white;"
        return "background:#fff3e0;color:#e65100;font-weight:700;"
      }

      const renderOrderRow = (d, isHistory = false) => {
            let items = d.items
            if (typeof items === 'string') try { items = JSON.parse(items) } catch(e) { items = [] }
            items = items || []
            const tr = document.createElement("tr")
            const tsDate = d.created_at || d.timestamp
            const ts = tsDate ? new Date(tsDate).toLocaleString() : ""
            const isPreorder = d.type === 'preorder'
            let orderTotal = Number(d.total || 0)
            if (orderTotal === 0 && items.length > 0) {
                orderTotal = items.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || item.qty || 1)), 0)
            }
            const insuff = resolveInsufficientInfo(d)
            const paidMarker = /\bpayment confirmed at\b/i.test(String(d.insufficient_notes || d.notes || "")) || /\-\s*paid\b/i.test(String(d.insufficient_notes || d.notes || ""))
            const isPaid = d.paymentStatus === 'paid' || d.status === 'paid' || d.status === 'PAID'
            let displayStatus = mapOrderStatus(d.status, d.currently_preparing, isPaid, insuff.hasMarker, paidMarker)
            const badgeStyle = getBadgeStyle(displayStatus)
            
            // If payment is confirmed, show Preparing
            if (paidMarker) {
                displayStatus = "Preparing"
            }
            
            let reasonDisplay = ""
            if (String(d.status || "").toLowerCase() === 'rejected') {
                reasonDisplay = d.rejection_reason || d.rejectionReason || d.insufficient_notes || d.notes || (items.find(i => i.rejection_reason)?.rejection_reason) || "No reason provided"
            } else if (insuff.hasMarker && insuff.stillNeeded > 0) {
                displayStatus = `Preparing, pay remaining amount: \u20B1${Number(insuff.stillNeeded).toFixed(2)}`
            } else if (insuff.hasMarker && displayStatus === "Preparing") {
                displayStatus = `Preparing`
            } else if (displayStatus === "For Pickup") {
                displayStatus = `Ready for pickup`
            } else if (insuff.hasMarker) {
                reasonDisplay = `\u26A0 Insufficient: Need \u20B1${Number(insuff.stillNeeded || d.total || 0).toFixed(2)}`
            }
            
            let confirmationNotice = ""
            const confirmedAt = parsePaymentConfirmedAt(d.insufficient_notes || d.notes || "")
            if (confirmedAt) confirmationNotice = `<div style="margin-top: 6px; color: #2e7d32; font-weight: 700;">Payment confirmed: ${new Date(confirmedAt).toLocaleString()}</div>`

            let qtyContent = items.length === 0 ? "-" : items.map(i => `<div style="margin-bottom: 4px;">${i.quantity || i.qty || 1}x</div>`).join("")
            let productContent = items.length === 0 ? "No items" : items.map(i => `<div style="margin-bottom: 4px; font-weight: 600;">${i.name || i.product || "Item"}</div>`).join("")

            if (isPreorder) {
              productContent += `<div style="font-weight:800;color:#d4a574;text-transform:uppercase;font-size:9px;letter-spacing:1px;margin-top:8px;">Pre-order Pickup</div>
                                 <div style="font-size:11px;color:#888;margin-top:2px;"><i class="fa-regular fa-clock" style="margin-right:4px;"></i>${d.date || "N/A"} ${d.pickup_time || d.time || "N/A"}</div>`
            }

            tr.innerHTML = `
              <td data-label="Qty" style="vertical-align: top;">${qtyContent}</td>
              <td data-label="Product" style="vertical-align: top;">${productContent}</td>
              <td data-label="Total" style="font-weight:800; color:var(--coffee-dark); font-size:16px; vertical-align: top;">\u20B1${Number(orderTotal).toFixed(2)}</td>
              <td data-label="Status" style="vertical-align: top;"><span class="badge" style="${badgeStyle}">${displayStatus}</span>${confirmationNotice}</td>
              <td data-label="Reason" style="font-size:13px; color:#666; vertical-align: top;">${reasonDisplay}</td>
              <td data-label="${isHistory ? 'Date' : 'Placed At'}" style="color:#888; font-size:13px; vertical-align: top;">${ts}</td>
            `
            return tr
      }

      // Render Active Orders
      if (orderBody) {
        orderBody.innerHTML = activeOrders.length === 0 ? '<tr><td colspan="6" style="text-align:center">No active orders</td></tr>' : ""
        activeOrders.forEach(d => orderBody.appendChild(renderOrderRow(d, false)))
      }

      // Render History
      if (historyBody) {
        historyBody.innerHTML = historyOrders.length === 0 ? '<tr><td colspan="6" style="text-align:center">No order history</td></tr>' : ""
        historyOrders.forEach(d => historyBody.appendChild(renderOrderRow(d, true)))
      }

      // Render Bookings
      if (bookingBody) {
        const combinedBookings = [...activeBookingsSection, ...bookingHistory]
        bookingBody.innerHTML = combinedBookings.length === 0 ? '<tr><td colspan="8" style="text-align:center">No bookings found</td></tr>' : ""
        combinedBookings.forEach((d) => {
            const tr = document.createElement("tr")
            const ts = (d.created_at || d.timestamp) ? new Date(d.created_at || d.timestamp).toLocaleString() : ""
            const time = d.type === "preorder" ? (d.pickup_time || d.time || "") : ((d.check_in_time && d.check_out_time) ? `${d.check_in_time} - ${d.check_out_time}` : (d.time || ""))
            
            let items = d.items
            if (typeof items === 'string') try { items = JSON.parse(items) } catch(e) { items = [] }
            items = items || []
            
            let productContent = d.type === "preorder" ? items.map(i => `<div style="margin-bottom: 2px; font-weight: 600;">${i.name || i.product || "Item"}</div>`).join("") : "Table Booking"
            let qtyContent = d.type === "preorder" ? items.map(i => `<div style="margin-bottom: 2px;">${i.quantity || i.qty || 1}x</div>`).join("") : "-"
            
            const log = rescheduleLogs.find(l => String(l.booking_id) === String(d.id))
            let rescheduleNotice = (log || d.rescheduled) ? `<div style="margin-top: 8px; padding: 8px; background: #e3f2fd; border: 1px solid #bbdefb; border-left: 4px solid #2196f3; border-radius: 4px; color: #0d47a1; font-size: 0.85em;"><strong>Notice:</strong> Your booking has been rescheduled to <b>${log ? log.new_date : d.date}</b> at <b>${log ? log.new_time : time}</b></div>` : ""
            
            const insuffStatus = resolveInsufficientInfo(d)
            let displayStatus = mapOrderStatus(d.status, d.currently_preparing, d.paymentStatus === 'paid', insuffStatus.hasMarker)
            if (insuffStatus.hasMarker && insuffStatus.stillNeeded > 0) {
                displayStatus = `Preparing, pay remaining amount: \u20B1${Number(insuffStatus.stillNeeded).toFixed(2)}`
            } else if (insuffStatus.hasMarker && displayStatus === "Preparing") {
                displayStatus = `Preparing`
            } else if (displayStatus === "For Pickup") {
                displayStatus = `Ready for pickup`
            }
            const badgeStyle = getBadgeStyle(displayStatus)

            tr.innerHTML = `
              <td data-label="Qty">${qtyContent}</td>
              <td data-label="Product">${productContent}</td>
              <td data-label="Type">${d.type === "preorder" ? "Pre-order" : "Visit"}</td>
              <td data-label="Date">${d.date || ""}</td>
              <td data-label="Time">${time}</td>
              <td data-label="Status"><span class="badge" style="${badgeStyle}">${displayStatus}</span>${rescheduleNotice}</td>
              <td data-label="Reason">${d.status === "rejected" ? (d.rejection_reason || "No reason provided") : (insuffStatus.hasMarker ? `\u26A0 Insufficient: Need \u20B1${insuffStatus.stillNeeded.toFixed(2)}` : "")}</td>
              <td data-label="Placed At">${ts}</td>
            `
            bookingBody.appendChild(tr)
        })
      }

      // Update bell count
      const insuffCount = [...activeOrders, ...activeBookingsSection].filter(o => resolveInsufficientInfo(o).hasMarker).length
      updateCustomerBell(insuffCount)

  } catch (err) {
      console.error("Critical error in runTrackOrder:", err)
      const msg = `<tr><td colspan="8" style="text-align:center; color:red;">Error: ${err.message}</td></tr>`
      if (orderBody) orderBody.innerHTML = msg
      if (historyBody) historyBody.innerHTML = msg
      if (bookingBody) bookingBody.innerHTML = msg
  }
}

// --- SPIN THE WHEEL LOGIC ---
let wheelCtx, rotation = 0, isSpinning = false, wheelItems = [], wheelWinner = null;
let wheelCanvasSize = 1000;
let wheelCatsSignature = "";

const WHEEL_CATEGORY_LABELS = {
  coffee: "Coffee",
  noncoffee: "Non-coffee",
  frappe: "Frappe",
  soda: "Soda",
  pastries: "Pastries",
  pastry: "Pastries",
  uncategorized: "Uncategorized"
};

const WHEEL_CATEGORY_ORDER = ["coffee", "noncoffee", "frappe", "soda", "pastries", "uncategorized"];

const normalizeWheelCategory = (value) => {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
};

const formatWheelCategoryLabel = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const norm = normalizeWheelCategory(raw);
  if (WHEEL_CATEGORY_LABELS[norm]) return WHEEL_CATEGORY_LABELS[norm];

  const cleaned = raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.replace(/\b\w/g, (m) => m.toUpperCase());
};

const resolveWheelPrice = (p) => {
  const raw = p?.price ?? p?.product_price ?? p?.productPrice ?? p?.product_price;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
};

const resolveWheelImage = (p) => {
  return (
    p?.image_url ||
    p?.photo ||
    p?.image ||
    p?.photo_url ||
    p?.photoUrl ||
    ""
  );
};

const resolveWheelSizeLabel = (p) => {
  const size = p?.size || p?.variant || p?.option;
  return size ? String(size).trim() : "";
};

const getWheelProductCategories = (p) => {
  const names = [];
  const pushName = (val) => {
    if (val === undefined || val === null) return;
    const name = String(val).trim();
    if (name) names.push(name);
  };

  const catId = p?.category_id;
  if (catId !== undefined && catId !== null && String(catId).trim() !== "") {
    const idNum = Number(catId);
    if (!Number.isNaN(idNum) && categories[idNum]) pushName(categories[idNum]);
    else pushName(catId);
  }
  pushName(p?.category);
  pushName(p?.category_name);
  pushName(p?.categoryName);
  return names;
};

const isWheelCoffee = (p) => {
  const cats = getWheelProductCategories(p).map(normalizeWheelCategory);
  return cats.includes("coffee");
};

const buildWheelCategoryListFromProducts = () => {
  const found = new Map();
  let hasUncategorized = false;

  (allProducts || []).forEach((p) => {
    if (p?.archived === true) return;
    const names = getWheelProductCategories(p);
    if (!names.length) {
      hasUncategorized = true;
      return;
    }
    names.forEach((name) => {
      const label = formatWheelCategoryLabel(name);
      const norm = normalizeWheelCategory(label);
      if (!norm) return;
      if (!found.has(norm)) found.set(norm, label);
    });
  });

  if (hasUncategorized) found.set("uncategorized", WHEEL_CATEGORY_LABELS.uncategorized);

  const ordered = [];
  WHEEL_CATEGORY_ORDER.forEach((norm) => {
    if (found.has(norm)) ordered.push(found.get(norm));
  });

  const extras = Array.from(found.entries()).filter(([norm]) => !WHEEL_CATEGORY_ORDER.includes(norm));
  extras.sort((a, b) => a[1].localeCompare(b[1]));
  extras.forEach(([, label]) => ordered.push(label));

  if (ordered.length) return ordered;
  const fallback = Object.values(categories || {});
  return fallback.length ? fallback : ["Coffee", "Non-coffee", "Frappe", "Soda", "Pastries"];
};

const getSelectedWheelCategories = () => {
  return Array.from(document.querySelectorAll('#wheelCatsList input:checked')).map((i) =>
    normalizeWheelCategory(i.value)
  );
};

const renderWheelCategories = (list) => {
  const container = document.getElementById("wheelCatsList");
  if (!container) return;

  const prevSelected = new Set(getSelectedWheelCategories());
  
  // Only auto-select all if it's the very first time (no categories ever loaded)
  const isFirstLoad = !container.hasChildNodes();

  container.innerHTML = "";
  list.forEach((label) => {
    const norm = normalizeWheelCategory(label);
    const isChecked = isFirstLoad || prevSelected.has(norm);

    const item = document.createElement("div");
    item.className = `wheel-cat-item${isChecked ? " active" : ""}`;
    item.innerHTML = `
      <span>${label}</span>
      <input type="checkbox" value="${label}" ${isChecked ? "checked" : ""}>
    `;
    item.onclick = (event) => {
      if (typeof window.toggleWheelCat === "function") window.toggleWheelCat(event, item);
    };

    const input = item.querySelector("input");
    if (input) {
      input.addEventListener("change", (event) => {
        if (typeof window.toggleWheelCat === "function") window.toggleWheelCat(event, item);
      });
    }

    container.appendChild(item);
  });
};

const syncWheelCategoryList = (force = false) => {
  const list = buildWheelCategoryListFromProducts();
  const signature = list.map((label) => normalizeWheelCategory(label)).join("|");
  if (!force && signature === wheelCatsSignature) return;
  wheelCatsSignature = signature;
  renderWheelCategories(list);
};

const resizeWheelCanvas = () => {
  const canvas = document.getElementById("wheelCanvas");
  if (!canvas) return;
  const container = canvas.parentElement;
  
  // Maximize wheel size for mobile: 90vw if screen is small
  const isMobile = window.innerWidth <= 768;
  const maxWidth = isMobile ? window.innerWidth * 0.92 : (container?.clientWidth || canvas.clientWidth);
  const maxHeight = isMobile ? window.innerHeight * 0.6 : (container?.clientHeight || maxWidth);
  
  const size = Math.max(240, Math.floor(Math.min(maxWidth, maxHeight)));
  if (!size) return;

  const dpr = window.devicePixelRatio || 1;
  const scaled = Math.round(size * dpr);
  if (canvas.width !== scaled || canvas.height !== scaled) {
    canvas.width = scaled;
    canvas.height = scaled;
  }

  wheelCanvasSize = size;
  wheelCtx = canvas.getContext("2d");
  if (wheelCtx) {
    wheelCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Ensure perfect square
  if (container) {
    container.style.height = `${size}px`;
    container.style.width = `${size}px`;
  }
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
};

const ensureWheelCategorySelection = () => {
  // Allow user to uncheck all categories.
  // We no longer force a selection here.
};

const setWheelStatus = (message, meta, show = true) => {
  const winnerText = document.getElementById("winnerText");
  const winnerMeta = document.getElementById("winnerMeta");
  const winnerBox = document.getElementById("winnerBox");

  if (winnerText && message !== undefined) winnerText.textContent = message;
  if (winnerMeta) {
    if (meta) {
      winnerMeta.textContent = meta;
      winnerMeta.style.display = "block";
    } else {
      winnerMeta.textContent = "";
      winnerMeta.style.display = "none";
    }
  }

  if (winnerBox) {
    if (show) winnerBox.classList.add("visible");
    else winnerBox.classList.remove("visible");
  }
};

const setWheelControlsDisabled = (disabled) => {
  document.querySelectorAll("#wheelCatsList input").forEach((cb) => {
    cb.disabled = !!disabled;
  });
};

const pickWheelVariant = (variants) => {
  let best = null;
  let bestScore = null;

  variants.forEach((v) => {
    if (v?.is_available === false) return;
    const price = resolveWheelPrice(v);
    const score = {
      hasPrice: price > 0,
      hasImage: !!resolveWheelImage(v),
      price,
      id: Number(v?.id || 0)
    };

    if (!best) {
      best = v;
      bestScore = score;
      return;
    }

    if (score.hasPrice !== bestScore.hasPrice) {
      if (score.hasPrice) {
        best = v;
        bestScore = score;
      }
      return;
    }

    if (score.hasImage !== bestScore.hasImage) {
      if (score.hasImage) {
        best = v;
        bestScore = score;
      }
      return;
    }

    if (score.hasPrice && bestScore.hasPrice && score.price !== bestScore.price) {
      if (score.price < bestScore.price) {
        best = v;
        bestScore = score;
      }
      return;
    }

    if (score.id && bestScore.id && score.id < bestScore.id) {
      best = v;
      bestScore = score;
    }
  });

  return best;
};

window.initWheel = () => {
  console.log("[v0] initWheel - starting initialization");
  const canvas = document.getElementById("wheelCanvas");
  if (!canvas) {
    console.error("[v0] initWheel - wheelCanvas not found");
    return;
  }

  resizeWheelCanvas();
  syncWheelCategoryList(true);
  ensureWheelCategorySelection();
  updateWheel();

  // Ensure layout is settled before first draw (prevents blank canvas on some devices)
  requestAnimationFrame(() => {
    resizeWheelCanvas();
    drawWheel();
  });

  setTimeout(() => {
    resizeWheelCanvas();
    drawWheel();
  }, 200);

  if (!window.__wheelResizeBound) {
    window.__wheelResizeBound = true;
    window.addEventListener("resize", () => {
      resizeWheelCanvas();
      drawWheel();
    });
    window.addEventListener("orientationchange", () => {
      resizeWheelCanvas();
      drawWheel();
    });
  }
};

window.toggleWheelCat = (event, el) => {
  if (!el || isSpinning) return;
  const cb = el.querySelector("input");
  if (!cb || cb.disabled) return;

  if (event && event.type !== "change" && event.target !== cb) {
    cb.checked = !cb.checked;
  }

  if (cb.checked) el.classList.add("active");
  else el.classList.remove("active");

  updateWheel();
};

window.updateWheel = () => {
  syncWheelCategoryList();
  ensureWheelCategorySelection();

  const checked = getSelectedWheelCategories();
  console.log("[v0] updateWheel - checked categories:", checked);

  const spinBtn = document.getElementById("spinBtn");
  const addBtn = document.getElementById("addCartWheelBtn");

  wheelWinner = null;
  if (addBtn) addBtn.style.display = "none";

  if (checked.length === 0) {
    wheelItems = [];
    if (spinBtn) {
      spinBtn.disabled = true;
      spinBtn.textContent = "Spin";
    }
    setWheelStatus("Select at least one category", "Choose categories to load items.");
    drawWheel();
    return;
  }

  if (!allProducts || allProducts.length === 0) {
    console.warn("[v0] updateWheel - no products available yet, fetching...");
    if (spinBtn) {
      spinBtn.disabled = true;
      spinBtn.textContent = "Loading...";
    }
    setWheelStatus("Loading menu items...", "Please wait while we fetch the menu.");
    if (!wheelIsLoading && typeof loadMenu === "function") {
      wheelIsLoading = true;
      loadMenu();
    }
    drawWheel();
    return;
  }

  wheelIsLoading = false;

  const selectedSet = new Set(checked);
  const filtered = allProducts.filter((p) => {
    if (!p || p.archived === true) return false;
    if (p.is_available === false) return false;
    const rawCats = getWheelProductCategories(p);
    const normCats = rawCats.map(normalizeWheelCategory).filter(Boolean);
    const categoriesToCheck = normCats.length ? normCats : ["uncategorized"];
    return categoriesToCheck.some((cat) => selectedSet.has(cat));
  });

  const grouped = new Map();
  filtered.forEach((p) => {
    const name = String(p.name || "").trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(p);
  });

  const uniqueItems = [];
  grouped.forEach((variants) => {
    const chosen = pickWheelVariant(variants);
    if (chosen) uniqueItems.push(chosen);
  });

  wheelItems = uniqueItems;

  if (spinBtn) {
    spinBtn.disabled = wheelItems.length === 0;
    spinBtn.textContent = "Spin";
  }

  if (wheelItems.length === 0) {
    setWheelStatus("No available items", "Try different categories or check back later.");
  } else {
    setWheelStatus(
      "Ready to Spin!",
      `${wheelItems.length} item${wheelItems.length === 1 ? "" : "s"} loaded.`
    );
  }

  drawWheel();
};

window.drawWheel = () => {
  if (!wheelCtx) {
    const canvas = document.getElementById("wheelCanvas");
    if (!canvas) return;
    wheelCtx = canvas.getContext("2d");
  }
  if (!wheelCtx) return;
  if (!wheelCanvasSize || wheelCanvasSize < 50) {
    resizeWheelCanvas();
  }

  const s = wheelCanvasSize || 1000;
  const c = s / 2;
  const rimWidth = Math.max(18, s * 0.045);
  const outerR = c - 2;
  const r = outerR - rimWidth;
  const dotRadius = Math.max(6, s * 0.012);
  const textRadius = r - Math.max(18, s * 0.045);
  const scale = s / 1000;

  wheelCtx.clearRect(0, 0, s, s);

  // Outer rim
  wheelCtx.beginPath();
  wheelCtx.arc(c, c, outerR, 0, Math.PI * 2);
  wheelCtx.fillStyle = "#111";
  wheelCtx.fill();

  // Inner ring shadow
  wheelCtx.beginPath();
  wheelCtx.arc(c, c, r + 4, 0, Math.PI * 2);
  wheelCtx.strokeStyle = "rgba(0,0,0,0.35)";
  wheelCtx.lineWidth = Math.max(2, s * 0.008);
  wheelCtx.stroke();

  // Rim dots
  const dotCount = Math.max(22, Math.round((Math.PI * 2 * outerR) / (dotRadius * 6)));
  for (let i = 0; i < dotCount; i++) {
    const a = (i * Math.PI * 2) / dotCount;
    wheelCtx.beginPath();
    wheelCtx.arc(
      c + (outerR - dotRadius * 0.6) * Math.cos(a),
      c + (outerR - dotRadius * 0.6) * Math.sin(a),
      dotRadius,
      0,
      Math.PI * 2
    );
    wheelCtx.fillStyle = "#FFD700";
    wheelCtx.fill();
  }

  if (wheelItems.length === 0) {
    const placeholderCount = 12;
    const slice = (Math.PI * 2) / placeholderCount;
    const wheelColors = ["#8b6b48", "#5a3d1e"];
    for (let i = 0; i < placeholderCount; i++) {
      const a = i * slice + rotation;
      wheelCtx.fillStyle = wheelColors[i % wheelColors.length];
      wheelCtx.beginPath();
      wheelCtx.moveTo(c, c);
      wheelCtx.arc(c, c, r, a, a + slice);
      wheelCtx.fill();
    }

    wheelCtx.fillStyle = "#f7f2e9";
    const fontSize = Math.max(14, Math.round(s * 0.04));
    wheelCtx.font = `bold ${fontSize}px Inter`;
    wheelCtx.textAlign = "center";

    const isAnyChecked = getSelectedWheelCategories().length > 0;
    const msg = isAnyChecked ? (wheelIsLoading ? "LOADING MENU..." : "NO ITEMS") : "SELECT CATEGORIES";
    wheelCtx.fillText(msg, c, c);
  } else {
    const slice = (Math.PI * 2) / wheelItems.length;
    const wheelColors = ["#8b6b48", "#5a3d1e", "#6f4a2b"];

    wheelItems.forEach((it, i) => {
      const a = i * slice + rotation;
      const segmentColor = wheelColors[i % wheelColors.length];

      wheelCtx.fillStyle = segmentColor;
      wheelCtx.beginPath();
      wheelCtx.moveTo(c, c);
      wheelCtx.arc(c, c, r, a, a + slice);
      wheelCtx.fill();

      wheelCtx.strokeStyle = "rgba(0,0,0,0.18)";
      wheelCtx.lineWidth = Math.max(1, s * 0.002);
      wheelCtx.stroke();

      // Text
      wheelCtx.save();
      wheelCtx.translate(c, c);
      const textAngle = a + slice / 2;
      wheelCtx.rotate(textAngle);

      wheelCtx.fillStyle = "#ffffff";

      let fontSize = 24 * scale;
      let textMaxLen = 30;
      
      if (wheelItems.length > 60) {
        fontSize = 10 * scale;
        textMaxLen = 14;
      } else if (wheelItems.length > 50) {
        fontSize = 12 * scale;
        textMaxLen = 16;
      } else if (wheelItems.length > 35) {
        fontSize = 14 * scale;
        textMaxLen = 20;
      } else if (wheelItems.length > 20) {
        fontSize = 18 * scale;
        textMaxLen = 25;
      }
      fontSize = Math.max(8, Math.round(fontSize));

      wheelCtx.font = `bold ${fontSize}px Inter`;
      wheelCtx.textBaseline = "middle";
      const angleNorm = (textAngle % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      
      const padding = Math.max(10, s * 0.02);
      const textX = r - padding;
      
      if (angleNorm > Math.PI / 2 && angleNorm < (Math.PI * 3) / 2) {
        wheelCtx.rotate(Math.PI);
        wheelCtx.textAlign = "left";
        const txt = truncateText(it.name || "", textMaxLen).toUpperCase();
        wheelCtx.fillText(txt, -textX, 0);
      } else {
        wheelCtx.textAlign = "right";
        const txt = truncateText(it.name || "", textMaxLen).toUpperCase();
        wheelCtx.fillText(txt, textX, 0);
      }
      wheelCtx.restore();
    });
  }

  // Center hub
  const hubRadius = Math.max(26, s * 0.07);
  wheelCtx.beginPath();
  wheelCtx.arc(c, c, hubRadius, 0, Math.PI * 2);
  wheelCtx.fillStyle = "#FFD700";
  wheelCtx.fill();
  wheelCtx.strokeStyle = "#111";
  wheelCtx.lineWidth = Math.max(2, s * 0.006);
  wheelCtx.stroke();
};

function truncateText(str, len) {
  if (!str) return "";
  const s = String(str).trim();
  return s.length > len ? s.substring(0, len - 2) + ".." : s;
}

window.spinTheWheel = () => {
  if (isSpinning || wheelItems.length === 0) return;
  isSpinning = true;

  const tapHint = document.getElementById('customerTapHint');
  if (tapHint) {
    tapHint.style.opacity = '0';
    tapHint.style.display = 'none'; // Hide completely so it doesn't reappear until reset
  }

  const spinBtn = document.getElementById("spinBtn");
  const addBtn = document.getElementById("addCartWheelBtn");
  const winnerBox = document.getElementById("winnerBox");

  if (spinBtn) {
    spinBtn.disabled = true;
    spinBtn.textContent = "Spinning...";
  }
  if (addBtn) addBtn.style.display = "none";
  if (winnerBox) {
    winnerBox.classList.remove("visible");
  }

  setWheelControlsDisabled(true);

  // Hero page spin logic: 4000-7000 degrees, 5s duration, p^4 easing
  const spinAngle = 4000 + Math.random() * 3000;
  const duration = 5000;
  const start = performance.now();
  const startRot = rotation;

  function anim(now) {
    let p = (now - start) / duration;
    if (p > 1) p = 1;

    const ease = 1 - Math.pow(1 - p, 4);

    rotation = startRot + (spinAngle * ease * Math.PI) / 180;
    drawWheel();

    if (p < 1) requestAnimationFrame(anim);
    else {
      isSpinning = false;
      // Do not automatically show tapHint here per user request
      
      if (spinBtn) {
        spinBtn.disabled = false;
        spinBtn.textContent = "Spin Again";
      }

      setWheelControlsDisabled(false);

      const slice = (Math.PI * 2) / wheelItems.length;
      const adj = (rotation + Math.PI / 2) % (Math.PI * 2);
      const idx = Math.floor((Math.PI * 2 - adj) / slice) % wheelItems.length;
      wheelWinner = wheelItems[idx];

      const winnerName = String(wheelWinner?.name || "Winner").trim();
      const sizeLabel = resolveWheelSizeLabel(wheelWinner);
      const price = resolveWheelPrice(wheelWinner);
      const metaParts = [];
      if (sizeLabel) metaParts.push(sizeLabel);
      if (price > 0) metaParts.push(`\u20B1${price.toFixed(2)}`);
      metaParts.push("Tap Add Cart to add this item.");

      setWheelStatus(winnerName, metaParts.join(" \u2022 "), true);

      if (addBtn) {
        addBtn.style.display = "flex";
        // Show tapHint again only if they want to spin again (optional, keeping it hidden for now)
      }
    }
  }
  requestAnimationFrame(anim);
};

// Reset tap hint when categories change
const originalUpdateWheel = window.updateWheel;
window.updateWheel = () => {
  if (typeof originalUpdateWheel === 'function') originalUpdateWheel();
  const tapHint = document.getElementById('customerTapHint');
  if (tapHint && !isSpinning) {
    tapHint.style.display = 'block';
    tapHint.style.opacity = '1';
  }
};

window.addWheelWinnerToCart = () => {
  if (!wheelWinner) return;

  const p = wheelWinner;
  const photo = resolveWheelImage(p);
  const price = resolveWheelPrice(p);
  const temperature = isWheelCoffee(p) ? "Hot" : null;

  if (typeof addToOrder === "function") {
    addToOrder(p.id, p.name, price, photo, temperature);

    // Show feedback
    const addBtn = document.getElementById("addCartWheelBtn");
    const originalContent = addBtn.innerHTML;
    addBtn.innerHTML = 'ADDED! <i class="fa-solid fa-check"></i>';
    addBtn.style.background = "#4CAF50";
    addBtn.style.color = "white";

    const winnerMeta = document.getElementById("winnerMeta");
    if (winnerMeta) winnerMeta.textContent = "Added to cart.";

    setTimeout(() => {
      addBtn.innerHTML = originalContent;
      addBtn.style.background = "";
      addBtn.style.color = "";
    }, 2000);
  } else {
    console.error("addToOrder function not found!");
  }
};

window.toggleMobileNav = () => {
  const sidebar = document.getElementById('mainNav');
  const overlay = document.querySelector('.mobile-nav-overlay');
  if (sidebar) sidebar.classList.toggle('mobile-active');
  if (overlay) overlay.classList.toggle('active');
}

window.customerLogout = () => {
  localStorage.removeItem("customer_auth")
  localStorage.removeItem("customer_cart")
  localStorage.removeItem("customer_preorder_cart")
  location.href = "../index.html"
}