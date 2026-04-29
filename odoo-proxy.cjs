'use strict';

const express = require('express');
const cors = require('cors');
const xmlrpc = require('xmlrpc');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors({
  origin: [
    'https://adri15ch.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Odoo config ────────────────────────────────────────────────────────────
const ODOO_URL  = 'importax.odoo.com';
const ODOO_DB   = 'importax';
const ODOO_USER = 'lourdesadriana15n@gmail.com';
const ODOO_PASS = process.env.ODOO_PASS || 'importadorax';

// ─── XML-RPC clients ─────────────────────────────────────────────────────────
function makeClient(path) {
  return xmlrpc.createSecureClient({
    host: ODOO_URL,
    port: 443,
    path,
  });
}

function call(client, method, params) {
  return new Promise((resolve, reject) => {
    client.methodCall(method, params, (err, val) => {
      if (err) return reject(err);
      resolve(val);
    });
  });
}

// ─── Authenticate → uid ───────────────────────────────────────────────────────
async function authenticate(user = ODOO_USER, pass = ODOO_PASS) {
  const common = makeClient('/xmlrpc/2/common');
  const uid = await call(common, 'authenticate', [ODOO_DB, user, pass, {}]);
  if (!uid) throw new Error('Credenciales incorrectas');
  return uid;
}

// ─── Generic execute_kw ───────────────────────────────────────────────────────
async function execute(uid, pass, model, method, args, kwargs = {}) {
  const object = makeClient('/xmlrpc/2/object');
  return call(object, 'execute_kw', [ODOO_DB, uid, pass, model, method, args, kwargs]);
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'SUMAQ Proxy OK', version: '2.0' }));

// ─── Test auth ────────────────────────────────────────────────────────────────
app.post('/api/odoo/test', async (req, res) => {
  try {
    const { username, password } = req.body;
    const uid = await authenticate(username || ODOO_USER, password || ODOO_PASS);
    res.json({ success: true, uid });
  } catch (e) {
    res.status(401).json({ success: false, error: e.message });
  }
});

// ─── Generic RPC ─────────────────────────────────────────────────────────────
app.post('/api/odoo/rpc', async (req, res) => {
  try {
    const { model, method, args = [], kwargs = {}, username, password } = req.body;
    if (!model || !method) return res.status(400).json({ error: 'model y method son requeridos' });

    const uid  = await authenticate(username || ODOO_USER, password || ODOO_PASS);
    const pass = password || ODOO_PASS;
    const result = await execute(uid, pass, model, method, args, kwargs);
    res.json({ success: true, result: result ?? [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Sync products ───────────────────────────────────────────────────────────
app.post('/api/odoo/sync', async (req, res) => {
  try {
    const uid = await authenticate();
    const productos = await execute(uid, ODOO_PASS, 'product.template', 'search_read',
      [[['sale_ok', '=', true], ['active', '=', true]]],
      {
        fields: [
          'id', 'name', 'list_price', 'description_sale', 'categ_id',
          'image_1920', 'qty_available', 'type', 'default_code',
        ],
        limit: 200,
        order: 'name asc',
      }
    );
    res.json({ success: true, productos: productos ?? [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Categorías ───────────────────────────────────────────────────────────────
app.post('/api/odoo/categorias', async (req, res) => {
  try {
    const uid = await authenticate();
    const cats = await execute(uid, ODOO_PASS, 'product.category', 'search_read',
      [[]],
      { fields: ['id', 'name', 'parent_id'], order: 'name asc' }
    );
    res.json({ success: true, categorias: cats ?? [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Clientes: buscar o crear ─────────────────────────────────────────────────
app.post('/api/odoo/cliente', async (req, res) => {
  try {
    const { email, name, phone } = req.body;
    if (!email) return res.status(400).json({ error: 'email requerido' });

    const uid = await authenticate();
    const found = await execute(uid, ODOO_PASS, 'res.partner', 'search_read',
      [[['email', '=', email]]],
      { fields: ['id', 'name', 'email', 'phone'], limit: 1 }
    );

    if (found && found.length > 0) {
      return res.json({ success: true, cliente: found[0], created: false });
    }

    const newId = await execute(uid, ODOO_PASS, 'res.partner', 'create', [{
      name: name || email.split('@')[0],
      email,
      phone: phone || '',
      customer_rank: 1,
    }]);
    res.json({ success: true, cliente: { id: newId, name, email, phone }, created: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Crear orden de venta ─────────────────────────────────────────────────────
// FIX: eliminados x_metodo_pago (campo inexistente) y payment_term_id:false
// FIX: product_id resuelto de template → variante antes de crear la línea
// FIX: action_confirm eliminado (devuelve None en SaaS 19.2 → error marshal)
app.post('/api/odoo/orden', async (req, res) => {
  try {
    const { partner_id, lineas, metodo_pago, notas } = req.body;
    if (!partner_id || !lineas?.length) {
      return res.status(400).json({ error: 'partner_id y lineas son requeridos' });
    }

    const uid = await authenticate();

    // El método de pago va en la nota (x_metodo_pago no existe en Odoo estándar)
    const notaFinal = [
      `MÉTODO DE PAGO: ${(metodo_pago || 'transferencia').toUpperCase()}`,
      notas || '',
    ].filter(Boolean).join('\n\n');

    // Crear la orden (solo campos estándar de Odoo)
    const orderId = await execute(uid, ODOO_PASS, 'sale.order', 'create', [{
      partner_id,
      note: notaFinal,
    }]);

    if (!orderId) throw new Error('Odoo no devolvió ID de orden');

    // Crear cada línea resolviendo template → variante
    for (const linea of lineas) {
      if (!linea.product_id && !linea.name) continue;

      let variantId = linea.product_id;

      if (linea.product_id) {
        // Buscar variante del template enviado desde el frontend
        const variants = await execute(uid, ODOO_PASS, 'product.product', 'search_read',
          [[['product_tmpl_id', '=', linea.product_id], ['active', '=', true]]],
          { fields: ['id'], limit: 1 }
        );
        if (variants?.length) {
          variantId = variants[0].id;
        } else {
          // Ya puede ser variante directa — verificar
          const directVariant = await execute(uid, ODOO_PASS, 'product.product', 'search_read',
            [[['id', '=', linea.product_id], ['active', '=', true]]],
            { fields: ['id'], limit: 1 }
          );
          variantId = directVariant?.length ? directVariant[0].id : linea.product_id;
        }
      }

      const lineData = {
        order_id: orderId,
        product_uom_qty: linea.qty || 1,
        price_unit: linea.price || 0,
        name: linea.name || '',
      };
      if (variantId) lineData.product_id = variantId;

      await execute(uid, ODOO_PASS, 'sale.order.line', 'create', [lineData]);
    }

    // No llamamos action_confirm (devuelve None en SaaS 19.2)
    // La orden queda en borrador; el admin la confirma desde Odoo o desde el panel admin
    res.json({ success: true, order_id: orderId });
  } catch (e) {
    console.error('[ORDEN ERROR]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Pedidos del cliente ──────────────────────────────────────────────────────
// Busca por email exacto + email en child_ids + todos los estados incluido draft
app.post('/api/odoo/pedidos', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email requerido' });

    const uid = await authenticate();

    // Buscar todos los partners con ese email (puede haber duplicados)
    const partners = await execute(uid, ODOO_PASS, 'res.partner', 'search_read',
      [[['email', '=', email]]],
      { fields: ['id', 'name'], limit: 10 }
    );
    if (!partners?.length) return res.json({ success: true, pedidos: [] });

    const partnerIds = partners.map(p => p.id);

    // Buscar pedidos de cualquiera de esos partners, todos los estados
    const pedidos = await execute(uid, ODOO_PASS, 'sale.order', 'search_read',
      [[['partner_id', 'in', partnerIds]]],
      {
        fields: ['id', 'name', 'date_order', 'state', 'amount_total', 'partner_id', 'amount_tax'],
        order: 'date_order desc',
        limit: 100,
      }
    );
    res.json({ success: true, pedidos: pedidos ?? [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Líneas de pedido ─────────────────────────────────────────────────────────
app.post('/api/odoo/pedido/lineas', async (req, res) => {
  try {
    const { order_id } = req.body;
    const uid = await authenticate();
    const lineas = await execute(uid, ODOO_PASS, 'sale.order.line', 'search_read',
      [[['order_id', '=', order_id]]],
      { fields: ['id', 'product_id', 'name', 'product_uom_qty', 'price_unit', 'price_subtotal'] }
    );
    res.json({ success: true, lineas: lineas ?? [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Admin: todos los pedidos ─────────────────────────────────────────────────
app.post('/api/odoo/admin/pedidos', async (req, res) => {
  try {
    const { username, password, estado, limit: lim = 100 } = req.body;
    const uid = await authenticate(username, password);
    const pass = password;

    const domain = estado ? [['state', '=', estado]] : [];
    const pedidos = await execute(uid, pass, 'sale.order', 'search_read',
      [domain],
      {
        fields: ['id', 'name', 'partner_id', 'date_order', 'state', 'amount_total', 'amount_tax'],
        order: 'date_order desc',
        limit: Number(lim),
      }
    );
    res.json({ success: true, pedidos: pedidos ?? [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Admin: cambiar estado de pedido ─────────────────────────────────────────
app.post('/api/odoo/admin/pedido/estado', async (req, res) => {
  try {
    const { username, password, order_id, action } = req.body;
    const uid = await authenticate(username, password);
    const pass = password;

    const validActions = {
      confirm: 'action_confirm',
      cancel:  'action_cancel',
      done:    'action_done',
      draft:   'action_draft',
    };
    const method = validActions[action];
    if (!method) return res.status(400).json({ error: 'Acción no válida' });

    await execute(uid, pass, 'sale.order', method, [[order_id]]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Admin: productos ─────────────────────────────────────────────────────────
app.post('/api/odoo/admin/productos', async (req, res) => {
  try {
    const { username, password, limit: lim = 200 } = req.body;
    const uid = await authenticate(username, password);
    const pass = password;

    const productos = await execute(uid, pass, 'product.template', 'search_read',
      [[]],
      {
        fields: [
          'id', 'name', 'list_price', 'type', 'qty_available',
          'categ_id', 'active', 'default_code', 'image_1920',
        ],
        limit: Number(lim),
        order: 'name asc',
      }
    );
    res.json({ success: true, productos: productos ?? [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── STOCK UPDATE — bug fix ───────────────────────────────────────────────────
// Solución: escribir directamente en stock.quant sin usar
// action_apply_inventory (devuelve None → falla en SaaS 19.2)
app.post('/api/odoo/stock/actualizar', async (req, res) => {
  try {
    const { username, password, product_id, quantity, location_id } = req.body;
    if (product_id === undefined || quantity === undefined) {
      return res.status(400).json({ error: 'product_id y quantity son requeridos' });
    }
    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty < 0) {
      return res.status(400).json({ error: 'quantity debe ser un número >= 0' });
    }

    const uid  = await authenticate(username || ODOO_USER, password || ODOO_PASS);
    const pass = password || ODOO_PASS;

    // 1. Verificar tipo de producto (service no maneja stock)
    const prods = await execute(uid, pass, 'product.product', 'search_read',
      [[['product_tmpl_id', '=', product_id]]],
      { fields: ['id', 'name', 'type', 'detailed_type'], limit: 1 }
    );

    // Si viene product_template id, buscar también por template
    let prod = prods?.[0];
    if (!prod) {
      const tmpl = await execute(uid, pass, 'product.template', 'search_read',
        [[['id', '=', product_id]]],
        { fields: ['id', 'name', 'type', 'product_variant_ids'], limit: 1 }
      );
      if (!tmpl?.length) return res.status(404).json({ error: 'Producto no encontrado' });

      const variantId = tmpl[0].product_variant_ids?.[0];
      if (!variantId) return res.status(404).json({ error: 'El producto no tiene variantes' });

      const variantData = await execute(uid, pass, 'product.product', 'search_read',
        [[['id', '=', variantId]]],
        { fields: ['id', 'name', 'type', 'detailed_type'], limit: 1 }
      );
      prod = variantData?.[0];
    }

    if (!prod) return res.status(404).json({ error: 'Producto no encontrado' });

    if (prod.type === 'service') {
      return res.json({
        success: false,
        warning: true,
        message: `"${prod.name}" es un producto de tipo servicio y no gestiona inventario.`,
      });
    }

    // 2. Buscar la ubicación interna por defecto si no se especifica
    let locId = location_id;
    if (!locId) {
      const locs = await execute(uid, pass, 'stock.location', 'search_read',
        [[['usage', '=', 'internal'], ['active', '=', true]]],
        { fields: ['id', 'name', 'complete_name'], limit: 1, order: 'id asc' }
      );
      locId = locs?.[0]?.id;
      if (!locId) return res.status(500).json({ error: 'No se encontró ubicación interna en Odoo' });
    }

    const variantProdId = prod.id;

    // 3. Buscar quant existente para producto + ubicación
    const quants = await execute(uid, pass, 'stock.quant', 'search_read',
      [[['product_id', '=', variantProdId], ['location_id', '=', locId]]],
      { fields: ['id', 'quantity', 'inventory_quantity'], limit: 1 }
    );

    if (quants?.length > 0) {
      // Actualizar directamente el campo quantity (evita action_apply_inventory)
      await execute(uid, pass, 'stock.quant', 'write',
        [[quants[0].id], { quantity: qty, inventory_quantity: qty }]
      );
    } else {
      // Crear nuevo quant con la cantidad directa
      await execute(uid, pass, 'stock.quant', 'create', [{
        product_id: variantProdId,
        location_id: locId,
        quantity: qty,
        inventory_quantity: qty,
      }]);
    }

    res.json({
      success: true,
      message: `Stock de "${prod.name}" actualizado a ${qty} unidades.`,
    });
  } catch (e) {
    console.error('[STOCK UPDATE ERROR]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Admin: estadísticas dashboard ───────────────────────────────────────────
app.post('/api/odoo/admin/stats', async (req, res) => {
  try {
    const { username, password } = req.body;
    const uid = await authenticate(username, password);
    const pass = password;

    const [totalPedidos, pedidosConfirmados, pedidosBorrador] = await Promise.all([
      execute(uid, pass, 'sale.order', 'search_read', [[]], {
        fields: ['id', 'amount_total', 'state', 'date_order'], limit: 1000,
      }),
      execute(uid, pass, 'sale.order', 'search_read', [[['state', '=', 'sale']]], {
        fields: ['id', 'amount_total'], limit: 1000,
      }),
      execute(uid, pass, 'sale.order', 'search_read', [[['state', '=', 'draft']]], {
        fields: ['id'], limit: 1000,
      }),
    ]);

    const totalVentas = (pedidosConfirmados ?? []).reduce((s, o) => s + (o.amount_total || 0), 0);

    res.json({
      success: true,
      stats: {
        total_pedidos: (totalPedidos ?? []).length,
        pedidos_confirmados: (pedidosConfirmados ?? []).length,
        pedidos_borrador: (pedidosBorrador ?? []).length,
        total_ventas: totalVentas,
        pedidos_recientes: (totalPedidos ?? []).slice(0, 10),
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Admin: alertas stock bajo ────────────────────────────────────────────────
app.post('/api/odoo/admin/stock-bajo', async (req, res) => {
  try {
    const { username, password, umbral = 5 } = req.body;
    const uid = await authenticate(username, password);
    const pass = password;

    const productos = await execute(uid, pass, 'product.template', 'search_read',
      [[['type', '!=', 'service'], ['active', '=', true], ['qty_available', '<=', Number(umbral)]]],
      { fields: ['id', 'name', 'qty_available', 'categ_id'], order: 'qty_available asc', limit: 50 }
    );
    res.json({ success: true, productos: productos ?? [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Admin: ubicaciones de stock ──────────────────────────────────────────────
app.post('/api/odoo/admin/ubicaciones', async (req, res) => {
  try {
    const { username, password } = req.body;
    const uid = await authenticate(username, password);
    const pass = password;

    const locs = await execute(uid, pass, 'stock.location', 'search_read',
      [[['usage', '=', 'internal'], ['active', '=', true]]],
      { fields: ['id', 'name', 'complete_name'], order: 'complete_name asc', limit: 100 }
    );
    res.json({ success: true, ubicaciones: locs ?? [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Admin: actualizar precio de producto ─────────────────────────────────────
app.post('/api/odoo/admin/producto/precio', async (req, res) => {
  try {
    const { username, password, product_id, list_price } = req.body;
    const uid = await authenticate(username, password);
    const pass = password;

    await execute(uid, pass, 'product.template', 'write',
      [[product_id], { list_price: parseFloat(list_price) }]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Admin: reportes de ventas por mes ───────────────────────────────────────
app.post('/api/odoo/admin/reporte/ventas', async (req, res) => {
  try {
    const { username, password } = req.body;
    const uid = await authenticate(username, password);
    const pass = password;

    const pedidos = await execute(uid, pass, 'sale.order', 'search_read',
      [[['state', 'in', ['sale', 'done']]]],
      { fields: ['date_order', 'amount_total', 'partner_id'], limit: 500, order: 'date_order asc' }
    );

    // Agrupar por mes en el proxy (evita read_group que puede devolver None)
    const byMonth = {};
    for (const p of (pedidos ?? [])) {
      const d = new Date(p.date_order);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!byMonth[key]) byMonth[key] = { mes: key, total: 0, count: 0 };
      byMonth[key].total += p.amount_total || 0;
      byMonth[key].count += 1;
    }

    res.json({ success: true, reporte: Object.values(byMonth) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SUMAQ Proxy v2.0 escuchando en :${PORT}`));
